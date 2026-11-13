import { randomUUID } from "node:crypto";
import type {
  AspectRatio,
  ChatAttachment,
  ChatMessage,
  RunError,
  RunEvent,
  RunStep,
} from "@my-lovart/shared";
import { env } from "../../lib/env.js";
import { chat } from "../../lib/llm.js";
import { normalizeAttachment } from "../files/file.store.js";
import { createMockRun, type MockKind } from "./mock-agent.js";
import {
  MAX_CONTEXT_MESSAGES,
  appendBlock,
  appendDelta,
  appendMessage,
  appendStep,
  appendThinking,
  ensureWorkspace,
  finishMessage,
  getWorkspace,
  markRunning,
  saveElements,
  setQueuePosition,
  startAssistantMessage,
  updateStep,
  updateToolProgress,
  updateToolStatus,
  type Workspace,
} from "./workspace.store.js";

export const MESSAGE_MAX = 4000;

export class WorkspaceInputError extends Error {}

const SYSTEM_PROMPT = `你是 mylovart 的 AI 设计助手，一个画布类设计工具里的对话角色。

要求：
- 用中文回答，简洁、具体、可执行。给建议时落到构图、配色（给出色值）、字体、尺寸这些层面。
- 不要写客套话和总结段落。
- 当前版本你只能对话，不能在画布上绘图。不要声称你已经画好了或正在生成，也不要让用户去点不存在的按钮。`;

export type RunInput = {
  text: string;
  kind: MockKind;
  aspectRatio?: AspectRatio;
  attachments?: ChatAttachment[];
};

type Payload<T> = T extends unknown ? Omit<T, "runId" | "messageId" | "seq" | "at"> : never;

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

      try {
        if (env.agentMode === "llm") {
          yield* runLlm(projectId, runId, messageId, signal);
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

/** LLM 模式没有工具，只有一条「生成回答」的步骤；事件形状保持一致。 */
async function* runLlm(
  projectId: string,
  runId: string,
  messageId: string,
  signal: AbortSignal,
): AsyncGenerator<RunEvent> {
  let seq = 0;
  const emit = (payload: Payload<RunEvent>): RunEvent =>
    ({
      ...payload,
      runId,
      messageId,
      seq: seq++,
      at: new Date().toISOString(),
    }) as RunEvent;

  const accepted = emit({ type: "run.accepted" });
  applyEvent(projectId, messageId, accepted);
  yield accepted;

  const started = emit({ type: "run.started" });
  applyEvent(projectId, messageId, started);
  yield started;

  const step: RunStep = {
    id: randomUUID(),
    kind: "reply",
    title: "生成回答",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  const stepStarted = emit({ type: "step.started", step });
  applyEvent(projectId, messageId, stepStarted);
  yield stepStarted;

  const workspace = ensureWorkspace(projectId);
  const history = workspace.messages
    .filter((message) => message.status !== "queued" && message.status !== "streaming")
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => ({ role: message.role, content: message.content }));

  try {
    const reply = await chat([{ role: "system", content: SYSTEM_PROMPT }, ...history]);
    if (signal.aborted) {
      const canceled = emit({ type: "run.canceled" });
      applyEvent(projectId, messageId, canceled);
      yield canceled;
      return;
    }

    const delta = emit({ type: "message.delta", delta: reply || "（模型没有返回内容）" });
    applyEvent(projectId, messageId, delta);
    yield delta;

    const stepDone = emit({ type: "step.updated", stepId: step.id, status: "done" });
    applyEvent(projectId, messageId, stepDone);
    yield stepDone;

    const completed = emit({ type: "run.completed" });
    applyEvent(projectId, messageId, completed);
    yield completed;
  } catch (err) {
    const error: RunError = {
      code: "llm_error",
      message: err instanceof Error ? err.message : "模型调用失败",
      retriable: true,
    };
    const failed = emit({ type: "run.failed", error });
    applyEvent(projectId, messageId, failed);
    yield failed;
  }
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
    case "thinking.delta":
      appendThinking(projectId, messageId, event.delta, event.at);
      return;
    case "message.delta":
      appendDelta(projectId, messageId, event.delta, event.at);
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