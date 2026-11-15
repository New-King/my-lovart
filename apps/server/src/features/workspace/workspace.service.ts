import { randomUUID } from "node:crypto";
import type {
  AspectRatio,
  ChatAttachment,
  ChatMessage,
  ImageBlock,
  RunError,
  RunEvent,
  VideoBlock,
} from "@my-lovart/shared";
import { env } from "../../lib/env.js";
import { createTrace } from "../../lib/trace.js";
import {
  collectLegacyAssets,
  mergeAssets,
  type ProjectAsset,
} from "../assets/assets.js";
import { getAssetsRepository } from "../assets/assets.repository.js";
import { normalizeAttachment } from "../files/file.store.js";
import { buildProjectStateContext } from "../storyboards/storyboards.context.js";
import { getStoryboardsRepository } from "../storyboards/storyboards.repository.js";
import { createMockRun, type MockKind } from "./mock-agent.js";
import {
  MAX_CONTEXT_MESSAGES,
  appendBlock,
  appendDelta,
  appendMessage,
  appendStep,
  appendThoughtDelta,
  ensureWorkspace,
  finishMessage,
  finishThought,
  getWorkspace,
  hydrateWorkspace,
  markRunning,
  replaceCanvas,
  saveElements,
  setMessageOptions,
  setMessageQuestions,
  setQueuePosition,
  startAssistantMessage,
  startThought,
  updateStep,
  updateToolProgress,
  updateToolStatus,
  type Workspace,
} from "./workspace.store.js";
import {
  getWorkspaceRepository,
  type WorkspaceRepository,
} from "./workspace.repository.js";

export const MESSAGE_MAX = 4000;
const HISTORY_CHAR_BUDGET = 12_000;
const HISTORY_MESSAGE_MAX_CHARS = 4_000;

/** checkpointer 是可选依赖：没装 pg 或没配库时退化，不影响消息/画布持久化。 */
type AgentCheckpointer = NonNullable<
  Parameters<typeof import("../agent/runtime.js").runAgent>[0]
>["checkpointer"];

const fallbackThreads = new Map<string, string>();

async function ensureThreadId(
  projectId: string,
  repo: WorkspaceRepository | null,
): Promise<string> {
  if (repo) {
    try {
      return await repo.getThreadId(projectId);
    } catch (err) {
      console.warn(
        "[checkpointer] thread_id 读取失败，退回进程内 thread：",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const existing = fallbackThreads.get(projectId);
  if (existing) return existing;
  const threadId = `thread_${randomUUID()}`;
  fallbackThreads.set(projectId, threadId);
  return threadId;
}

async function loadCheckpointer(): Promise<AgentCheckpointer | null> {
  try {
    const { getCheckpointer } = await import("../agent/persistence/checkpointer.js");
    return ((await getCheckpointer()) as AgentCheckpointer | null) ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find package")) {
      console.warn(
        "[checkpointer] 未启用：请先在项目根目录运行 pnpm install（新增 pg / @langchain/langgraph-checkpoint-postgres）",
      );
    } else {
      console.warn("[checkpointer] 未启用（初始化失败）：", message);
    }
    return null;
  }
}

/**
 * checkpoint 不可用后不要继续用同一条 thread：
 * 换 thread_id，下一轮 getTuple 为空，runtime 会用已落库的消息历史重建。
 */
async function rotateThread(
  projectId: string,
  repo: WorkspaceRepository | null,
  oldThreadId: string,
): Promise<void> {
  fallbackThreads.delete(projectId);
  if (repo) {
    try {
      await repo.resetThreadId(projectId);
    } catch (err) {
      console.warn(
        "[checkpointer] 轮换 thread_id 失败：",
        err instanceof Error ? err.message : err,
      );
    }
  }
  try {
    const { deleteThreadCheckpoints } = await import(
      "../agent/persistence/checkpointer.js"
    );
    void deleteThreadCheckpoints(oldThreadId).catch((err) => {
      console.warn(
        "[checkpointer] 清理旧 thread 失败：",
        err instanceof Error ? err.message : err,
      );
    });
  } catch (err) {
    console.warn(
      "[checkpointer] 清理旧 thread 失败：",
      err instanceof Error ? err.message : err,
    );
  }
}

export class WorkspaceInputError extends Error {}

export type RunInput = {
  text: string;
  kind: MockKind;
  aspectRatio?: AspectRatio;
  attachments?: ChatAttachment[];
  /** 当前这条用户消息的 id；历史里要排除它，避免同一条消息传两遍 */
  userMessageId?: string;
  /** 服务端自己的公开地址，用于把生成结果落成 /files/:id */
  baseUrl?: string;
  /** 请求侧看到的原始附件数量；和归一化结果对不上时用于定位 */
  rawAttachmentCount?: number;
  /** Fastify 的 requestId，方便和服务端日志对齐 */
  requestId?: string;
};

const ASPECTS: AspectRatio[] = ["1:1", "4:3", "3:4", "16:9", "9:16"];

export function normalizeAspect(input: unknown): AspectRatio | undefined {
  return typeof input === "string" && (ASPECTS as string[]).includes(input)
    ? (input as AspectRatio)
    : undefined;
}

/**
 * 客户端传来的附件可能是 data URL、mock 资源或远端地址。
 * 一律先落成稳定地址，再写进消息；无效附件直接丢弃。
 */
export async function normalizeAttachments(
  raw: unknown,
  baseUrl: string,
): Promise<ChatAttachment[]> {
  if (!Array.isArray(raw)) return [];
  const result: ChatAttachment[] = [];
  for (const item of raw.slice(0, 8)) {
    if (typeof item !== "object" || item === null) continue;
    const attachment = await normalizeAttachment(item as Record<string, unknown>, baseUrl);
    if (attachment) result.push(attachment);
  }
  return result;
}

export function createWorkspaceService(
  repositoryReady: Promise<WorkspaceRepository | null> = getWorkspaceRepository(),
) {
  const loadedProjects = new Set<string>();

  async function ensureLoaded(projectId: string): Promise<WorkspaceRepository | null> {
    const repo = await repositoryReady;
    if (!repo) return null;
    if (loadedProjects.has(projectId)) return repo;
    try {
      const snapshot = await repo.load(projectId);
      hydrateWorkspace(projectId, snapshot);
      loadedProjects.add(projectId);
    } catch (err) {
      console.error("[workspace] 持久层加载失败，本轮回落到内存：", err);
      return null;
    }
    return repo;
  }

  /**
   * 画布可能被另一个进程（worker / 旧 dev server）写过。
   * 读画布前从 DB 刷新一次，不能只信进程内缓存。
   */
  async function refreshCanvas(
    projectId: string,
    repo: WorkspaceRepository | null,
  ): Promise<void> {
    if (!repo) return;
    try {
      const snapshot = await repo.loadCanvas(projectId);
      replaceCanvas(projectId, snapshot.elements, snapshot.files, snapshot.canvasRevision);
    } catch (err) {
      console.warn(
        "[workspace] 画布刷新失败，使用进程内缓存：",
        err instanceof Error ? err.message : err,
      );
    }
  }

  async function persistMessage(
    repo: WorkspaceRepository | null,
    projectId: string,
    messageId: string,
  ): Promise<void> {
    if (!repo) return;
    const message = ensureWorkspace(projectId).messages.find((item) => item.id === messageId);
    if (!message) return;
    try {
      await repo.saveMessage(projectId, message);
    } catch (err) {
      console.error("[workspace] 消息写库失败：", err);
    }
  }

  return {
    async get(projectId: string): Promise<Workspace> {
      const repo = await ensureLoaded(projectId);
      await refreshCanvas(projectId, repo);
      return getWorkspace(projectId);
    },

    async saveCanvas(
      projectId: string,
      elements: unknown,
      files?: unknown,
      expectedRevision = 0,
    ): Promise<Workspace> {
      if (!Array.isArray(elements)) throw new WorkspaceInputError("elements 必须是数组");
      if (
        files !== undefined &&
        (typeof files !== "object" || files === null || Array.isArray(files))
      ) {
        throw new WorkspaceInputError("files 必须是对象");
      }
      await ensureLoaded(projectId);
      const repo = await repositoryReady;
      const workspace = ensureWorkspace(projectId);
      let revision = workspace.canvasRevision;
      if (repo) {
        try {
          revision = await repo.saveCanvas(
            projectId,
            elements,
            (files as Record<string, unknown> | undefined) ?? workspace.files,
            expectedRevision,
          );
        } catch (err) {
          console.error("[workspace] 画布写库失败：", err);
          throw err;
        }
      } else {
        revision += 1;
      }
      return saveElements(
        projectId,
        elements,
        (files as Record<string, unknown> | undefined) ?? workspace.files,
        revision,
      );
    },

    /** 用户消息先落库，再开始运行；失败也不会丢这句话。 */
    async appendUserMessage(
      projectId: string,
      text: string,
      attachments: ChatAttachment[],
    ): Promise<ChatMessage> {
      if (!text && attachments.length === 0) throw new WorkspaceInputError("消息不能为空");
      if (text.length > MESSAGE_MAX) throw new WorkspaceInputError("消息过长");
      await ensureLoaded(projectId);
      const message = appendMessage(projectId, "user", text, { attachments });
      const repo = await repositoryReady;
      if (repo) await persistMessage(repo, projectId, message.id);
      return message;
    },

    /**
     * 一次运行：助手消息占位 → 逐事件写库 → 收尾。
     * 事件同时写给调用方（SSE），两边看到的是同一份内容。
     */
    async *run(
      projectId: string,
      input: RunInput,
      signal: AbortSignal,
    ): AsyncGenerator<RunEvent> {
      const repo = await ensureLoaded(projectId);
      await refreshCanvas(projectId, repo);
      const runId = randomUUID();
      const messageId = randomUUID();
      const runStartedAt = new Date().toISOString();
      startAssistantMessage(projectId, messageId);
      await persistMessage(repo, projectId, messageId);

      const candidates = ensureWorkspace(projectId).messages
        .filter((message) => message.status !== "queued" && message.status !== "streaming")
        .filter((message) => message.id !== input.userMessageId)
        .slice(-MAX_CONTEXT_MESSAGES)
        .map((message) => ({
          role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: message.content.slice(0, HISTORY_MESSAGE_MAX_CHARS),
        }))
        .filter((message) => message.content);

      // 从最新往回装，超预算就丢最旧的；checkpointer 开启时 runtime 不会重复使用它
      const history: typeof candidates = [];
      let historyChars = 0;
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const message = candidates[index];
        if (!message) continue;
        if (
          history.length > 0 &&
          historyChars + message.content.length > HISTORY_CHAR_BUDGET
        ) {
          break;
        }
        history.unshift(message);
        historyChars += message.content.length;
      }

      const assetRepo = await getAssetsRepository();
      let storedAssets: ProjectAsset[] = [];
      try {
        storedAssets = await assetRepo.list(projectId, 40);
      } catch (err) {
        console.warn(
          "[assets] 读取产物账本失败，先使用消息里的旧产物：",
          err instanceof Error ? err.message : err,
        );
      }
      const projectAssets = mergeAssets(
        storedAssets,
        collectLegacyAssets(ensureWorkspace(projectId).messages),
      );

      let projectState = {
        xml: "",
        summary: "",
        storyboardCount: 0,
      } as ReturnType<typeof buildProjectStateContext>;
      try {
        const storyboards = await getStoryboardsRepository();
        const boards = await storyboards.list(projectId);
        const activeSummary = boards.find((board) => board.active) ?? boards[0];
        const activeDetail = activeSummary
          ? await storyboards.get(projectId, activeSummary.id)
          : null;
        projectState = buildProjectStateContext(boards, activeDetail);
      } catch (err) {
        console.warn(
          "[storyboards] 分镜上下文加载失败：",
          err instanceof Error ? err.message : err,
        );
      }

      const checkpointer = env.generationMode === "real" ? await loadCheckpointer() : null;
      const threadId = checkpointer ? await ensureThreadId(projectId, repo) : undefined;

      const trace = createTrace(runId, {
        projectId,
        messageId,
        requestId: input.requestId,
        kind: input.kind,
        text: input.text.slice(0, 500),
        rawAttachmentCount: input.rawAttachmentCount ?? 0,
        inputAttachments: (input.attachments ?? []).map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          urlKind: attachment.url.startsWith("data:")
            ? "data-url"
            : attachment.url.includes("/files/")
              ? "local-file"
              : "remote-url",
        })),
        historyCount: history.length,
        historyChars,
        projectAssetCount: projectAssets.length,
        storyboardCount: projectState.storyboardCount,
        activeStoryboardId: projectState.activeStoryboardId,
        projectStateSummary: projectState.summary,
        checkpointer: Boolean(checkpointer),
        threadId,
        history: history.map((message) => ({
          role: message.role,
          preview: message.content.slice(0, 120),
        })),
      });

      const persistArtifact = async (
        artifact: ImageBlock | VideoBlock,
        at: string,
      ): Promise<void> => {
        const asset = assetFromArtifact(projectId, messageId, artifact, at);
        try {
          await assetRepo.save(projectId, asset);
          trace.event("asset.saved", {
            id: asset.id,
            kind: asset.kind,
            title: asset.title,
          });
        } catch (err) {
          console.warn(
            "[assets] 产物落账本失败：",
            err instanceof Error ? err.message : err,
          );
          trace.event("asset.save_failed", {
            id: asset.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      try {
        if (env.generationMode === "real") {
          const baseUrl = input.baseUrl ?? `http://127.0.0.1:${env.port}`;
          let runAgent: typeof import("../agent/runtime.js").runAgent;
          try {
            ({ runAgent } = await import("../agent/runtime.js"));
          } catch (err) {
            const error: RunError = {
              code: "dependency_missing",
              message:
                err instanceof Error && err.message.includes("Cannot find package")
                  ? "Agent 依赖尚未安装，请在项目根目录运行 pnpm install 后重启服务"
                  : "Agent 运行时加载失败，请检查服务端日志",
              retriable: true,
            };
            finishMessage(projectId, messageId, "failed", new Date().toISOString(), error);
            await persistMessage(repo, projectId, messageId);
            yield {
              type: "run.failed",
              runId,
              messageId,
              seq: 0,
              at: new Date().toISOString(),
              error,
            };
            return;
          }

          for await (const event of runAgent({
            runId,
            messageId,
            projectId,
            runStartedAt,
            text: input.text,
            kind: input.kind,
            aspectRatio: input.aspectRatio,
            attachments: collectRunAttachments(
              ensureWorkspace(projectId),
              input.attachments ?? [],
            ),
            projectAssets,
            history,
            canvasElements: ensureWorkspace(projectId).elements,
            canvasFiles: ensureWorkspace(projectId).files,
            projectStateXml: projectState.xml,
            baseUrl,
            signal,
            trace,
            ...(checkpointer ? { checkpointer } : {}),
            ...(threadId
              ? {
                  threadId,
                  onCheckpointUnavailable: (brokenThreadId: string) =>
                    rotateThread(projectId, repo, brokenThreadId),
                }
              : {}),
          })) {
            if (
              event.type === "artifact.ready" &&
              (event.artifact.type === "image" || event.artifact.type === "video")
            ) {
              await persistArtifact(event.artifact, event.at);
            }
            applyEvent(projectId, messageId, event);
            const terminal =
              event.type === "run.completed" ||
              event.type === "run.canceled" ||
              event.type === "run.failed";
            trace.event("run.event", summarizeEvent(event));
            if (terminal) await persistMessage(repo, projectId, messageId);
            yield event;
            if (terminal) return;
          }
          return;
        }

        for await (const event of createMockRun({
          runId,
          messageId,
          projectId,
          text: input.text,
          kind: input.kind,
          aspectRatio: input.aspectRatio,
          attachments: input.attachments ?? [],
          signal,
        })) {
          if (
            event.type === "artifact.ready" &&
            (event.artifact.type === "image" || event.artifact.type === "video")
          ) {
            await persistArtifact(event.artifact, event.at);
          }
          applyEvent(projectId, messageId, event);
          const terminal =
            event.type === "run.completed" ||
            event.type === "run.canceled" ||
            event.type === "run.failed";
          trace.event("run.event", summarizeEvent(event));
          if (terminal) await persistMessage(repo, projectId, messageId);
          yield event;
          if (terminal) return;
        }
      } catch (err) {
        const error: RunError = {
          code: "internal_error",
          message: err instanceof Error ? err.message : "生成失败",
          retriable: true,
        };
        trace.event("run.error", {
          message: error.message,
          stack: err instanceof Error ? err.stack : undefined,
        });
        finishMessage(projectId, messageId, "failed", new Date().toISOString(), error);
        await persistMessage(repo, projectId, messageId);
        yield {
          type: "run.failed",
          runId,
          messageId,
          seq: 99_999,
          at: new Date().toISOString(),
          error,
        };
      } finally {
        const message = ensureWorkspace(projectId).messages.find(
          (item) => item.id === messageId,
        );
        if (message?.status === "queued" || message?.status === "streaming") {
          // 客户端断开、进程异常等没有终态事件的情况，按取消收尾
          finishMessage(projectId, messageId, "canceled", new Date().toISOString());
          await persistMessage(repo, projectId, messageId);
        }
        trace.event("run.finally", { status: message?.status ?? "unknown" });
      }
    },
  };
}

function assetFromArtifact(
  projectId: string,
  messageId: string,
  artifact: ImageBlock | VideoBlock,
  at: string,
): ProjectAsset {
  return {
    id: artifact.id,
    projectId,
    kind: artifact.type,
    origin: "generated",
    title:
      artifact.title?.trim() ||
      artifact.prompt?.trim().slice(0, 40) ||
      (artifact.type === "video" ? "未命名视频" : "未命名图片"),
    prompt: artifact.prompt ?? "",
    ...(artifact.model ? { model: artifact.model } : {}),
    url: artifact.url,
    mimeType: artifact.mimeType,
    width: artifact.width,
    height: artifact.height,
    ...(artifact.type === "video" && artifact.durationSeconds
      ? { durationSeconds: artifact.durationSeconds }
      : {}),
    ...(artifact.type === "image" && artifact.aspectRatio
      ? { aspectRatio: artifact.aspectRatio }
      : {}),
    sourceAssetIds: artifact.sourceAssetIds ?? [],
    ...(artifact.shotId ? { shotId: artifact.shotId } : {}),
    messageId,
    metadata: {
      ...(artifact.batchId ? { batchId: artifact.batchId } : {}),
      ...(artifact.type === "image" && artifact.role ? { role: artifact.role } : {}),
    },
    createdAt: at,
  };
}

function summarizeEvent(event: RunEvent): Record<string, unknown> {
  const base = { type: event.type };
  switch (event.type) {
    case "message.delta":
      return { ...base, chars: event.delta.length };
    case "message.options":
      return { ...base, options: event.options };
    case "message.questions":
      return { ...base, questions: event.questions.map((question) => question.question) };
    case "tool.started":
      return { ...base, tool: event.tool.tool, title: event.tool.title };
    case "tool.failed":
      return { ...base, error: event.error.message.slice(0, 300) };
    case "run.failed":
      return { ...base, error: event.error };
    case "artifact.ready":
      return { ...base, kind: event.artifact.type, id: event.artifact.id };
    default:
      return base;
  }
}

/**
 * 当前消息的附件 + 最近几轮用户发过的图片。
 * 附件只在发送那一轮存在，下一轮说「给这张图加点元素」时模型不能失忆。
 */
function collectRunAttachments(
  workspace: Workspace,
  current: ChatAttachment[],
  limit = 8,
): ChatAttachment[] {
  const result: ChatAttachment[] = [];
  const seen = new Set<string>();

  const push = (attachment: ChatAttachment) => {
    if (result.length >= limit) return;
    if (!attachment.mimeType.startsWith("image/")) return;
    if (seen.has(attachment.url)) return;
    seen.add(attachment.url);
    result.push(attachment);
  };

  for (const attachment of current) push(attachment);

  for (let index = workspace.messages.length - 1; index >= 0; index -= 1) {
    if (result.length >= limit) break;
    const message = workspace.messages[index];
    if (!message || message.role !== "user") continue;
    for (const attachment of message.attachments ?? []) push(attachment);
  }

  return result;
}

function applyEvent(projectId: string, messageId: string, event: RunEvent): void {
  switch (event.type) {
    case "run.accepted":
      if (event.queuePosition !== undefined) {
        setQueuePosition(projectId, messageId, event.queuePosition, event.at);
      }
      return;
    case "run.started":
      markRunning(projectId, messageId, event.at);
      return;
    case "step.started":
      appendStep(projectId, messageId, event.step);
      return;
    case "step.updated":
      updateStep(projectId, messageId, event.stepId, {
        status: event.status,
        detail: event.detail,
        at: event.at,
      });
      return;
    case "thinking.started":
      startThought(projectId, messageId, {
        id: event.thoughtId,
        text: "",
        startedAt: event.startedAt,
      });
      return;
    case "thinking.delta":
      appendThoughtDelta(projectId, messageId, event.thoughtId, event.delta, event.at);
      return;
    case "thinking.completed":
      finishThought(projectId, messageId, event.thoughtId, event.at);
      return;
    case "message.delta":
      appendDelta(projectId, messageId, event.delta, event.at);
      return;
    case "message.options":
      setMessageOptions(projectId, messageId, event.options, event.at);
      return;
    case "message.questions":
      setMessageQuestions(projectId, messageId, event.questions, event.at);
      return;
    case "tool.started":
      appendBlock(projectId, messageId, event.tool, event.at);
      return;
    case "tool.progress":
      updateToolProgress(projectId, messageId, event.toolCallId, {
        progress: event.progress,
        stage: event.stage,
        at: event.at,
      });
      return;
    case "tool.completed":
      updateToolStatus(
        projectId,
        messageId,
        event.toolCallId,
        "done",
        event.outputSummary,
        event.at,
      );
      return;
    case "tool.failed":
      updateToolStatus(
        projectId,
        messageId,
        event.toolCallId,
        "failed",
        event.error.message,
        event.at,
      );
      return;
    case "artifact.ready":
      appendBlock(projectId, messageId, event.artifact, event.at);
      return;
    case "canvas.command":
      return;
    case "canvas.sync":
      return;
    case "run.completed":
      finishMessage(projectId, messageId, "completed", event.at);
      return;
    case "run.canceled":
      finishMessage(projectId, messageId, "canceled", event.at);
      return;
    case "run.failed":
      finishMessage(projectId, messageId, "failed", event.at, event.error);
      return;
  }
}