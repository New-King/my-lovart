import { randomUUID } from "node:crypto";
import type {
  AspectRatio,
  ChatAttachment,
  ChatMessage,
  RunError,
  RunEvent,
} from "@my-lovart/shared";
import { env } from "../../lib/env.js";
import { normalizeAttachment } from "../files/file.store.js";
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
  markRunning,
  saveElements,
  setMessageOptions,
  setQueuePosition,
  startAssistantMessage,
  startThought,
  updateStep,
  updateToolProgress,
  updateToolStatus,
  type Workspace,
} from "./workspace.store.js";

export const MESSAGE_MAX = 4000;

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
export function normalizeAttachments(raw: unknown, baseUrl: string): ChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  const result: ChatAttachment[] = [];
  for (const item of raw.slice(0, 8)) {
    if (typeof item !== "object" || item === null) continue;
    const attachment = normalizeAttachment(item as Record<string, unknown>, baseUrl);
    if (attachment) result.push(attachment);
  }
  return result;
}

export function createWorkspaceService() {
  return {
    get(projectId: string): Workspace {
      return getWorkspace(projectId);
    },

    saveCanvas(projectId: string, elements: unknown, files?: unknown): Workspace {
      if (!Array.isArray(elements)) throw new WorkspaceInputError("elements 必须是数组");
      if (
        files !== undefined &&
        (typeof files !== "object" || files === null || Array.isArray(files))
      ) {
        throw new WorkspaceInputError("files 必须是对象");
      }
      return saveElements(projectId, elements, files as Record<string, unknown> | undefined);
    },

    /** 用户消息先落库，再开始运行；失败也不会丢这句话。 */
    appendUserMessage(
      projectId: string,
      text: string,
      attachments: ChatAttachment[],
    ): ChatMessage {
      if (!text && attachments.length === 0) throw new WorkspaceInputError("消息不能为空");
      if (text.length > MESSAGE_MAX) throw new WorkspaceInputError("消息过长");
      return appendMessage(projectId, "user", text, { attachments });
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
      const runId = randomUUID();
      const messageId = randomUUID();
      startAssistantMessage(projectId, messageId);

      const history = ensureWorkspace(projectId).messages
        .filter((message) => message.status !== "queued" && message.status !== "streaming")
        .filter((message) => message.id !== input.userMessageId)
        .slice(-MAX_CONTEXT_MESSAGES)
        .map((message) => ({
          role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: message.content,
        }))
        .filter((message) => message.content);

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
            text: input.text,
            kind: input.kind,
            aspectRatio: input.aspectRatio,
            attachments: collectRunAttachments(
              ensureWorkspace(projectId),
              input.attachments ?? [],
            ),
            history,
            canvasElements: ensureWorkspace(projectId).elements,
            canvasFiles: ensureWorkspace(projectId).files,
            baseUrl,
            signal,
          })) {
            applyEvent(projectId, messageId, event);
            yield event;
            if (
              event.type === "run.completed" ||
              event.type === "run.canceled" ||
              event.type === "run.failed"
            ) {
              return;
            }
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
          applyEvent(projectId, messageId, event);
          yield event;
          if (
            event.type === "run.completed" ||
            event.type === "run.canceled" ||
            event.type === "run.failed"
          ) {
            return;
          }
        }
      } catch (err) {
        const error: RunError = {
          code: "internal_error",
          message: err instanceof Error ? err.message : "生成失败",
          retriable: true,
        };
        finishMessage(projectId, messageId, "failed", new Date().toISOString(), error);
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
        }
      }
    },
  };
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