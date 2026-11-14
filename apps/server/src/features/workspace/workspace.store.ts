import { randomUUID } from "node:crypto";
import type {
  ChatAttachment,
  ChatBlock,
  ChatMessage,
  RunError,
  RunStep,
  RunStepStatus,
  Thought,
  ToolBlock,
} from "@my-lovart/shared";

export type Workspace = {
  projectId: string;
  elements: unknown[];
  files: Record<string, unknown>;
  messages: ChatMessage[];
};

const workspaces = new Map<string, Workspace>();

export function ensureWorkspace(projectId: string): Workspace {
  let ws = workspaces.get(projectId);
  if (!ws) {
    ws = { projectId, elements: [], files: {}, messages: [] };
    workspaces.set(projectId, ws);
  }
  if (!ws.files) ws.files = {};
  return ws;
}

export function getWorkspace(projectId: string): Workspace {
  return ensureWorkspace(projectId);
}

export function saveElements(
  projectId: string,
  elements: unknown[],
  files?: Record<string, unknown>,
): Workspace {
  const ws = ensureWorkspace(projectId);
  ws.elements = elements;
  if (files) ws.files = files;
  return ws;
}

export function appendMessage(
  projectId: string,
  role: ChatMessage["role"],
  content: string,
  options: { blocks?: ChatBlock[]; attachments?: ChatAttachment[] } = {},
): ChatMessage {
  const ws = ensureWorkspace(projectId);
  const message: ChatMessage = {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(role === "assistant" ? { status: "completed" as const } : {}),
    ...(options.blocks && options.blocks.length > 0 ? { blocks: options.blocks } : {}),
    ...(options.attachments && options.attachments.length > 0
      ? { attachments: options.attachments }
      : {}),
  };
  ws.messages.push(message);
  return message;
}

/** 助手消息先以空内容占位，运行过程中逐段填充。 */
export function startAssistantMessage(
  projectId: string,
  id: string,
  at = new Date().toISOString(),
): ChatMessage {
  const ws = ensureWorkspace(projectId);
  const message: ChatMessage = {
    id,
    role: "assistant",
    content: "",
    createdAt: at,
    updatedAt: at,
    status: "queued",
    steps: [],
    blocks: [],
  };
  ws.messages.push(message);
  return message;
}

function findMessage(projectId: string, messageId: string): ChatMessage | undefined {
  return ensureWorkspace(projectId).messages.find((message) => message.id === messageId);
}

function touch(message: ChatMessage, at: string): void {
  message.updatedAt = at;
}

export function markRunning(projectId: string, messageId: string, at: string): void {
  const message = findMessage(projectId, messageId);
  if (!message) return;
  message.status = "streaming";
  touch(message, at);
}

export function setQueuePosition(
  projectId: string,
  messageId: string,
  queuePosition: number,
  at: string,
): void {
  const message = findMessage(projectId, messageId);
  if (!message) return;
  message.queuePosition = queuePosition;
  touch(message, at);
}

export function appendDelta(
  projectId: string,
  messageId: string,
  delta: string,
  at: string,
): void {
  const message = findMessage(projectId, messageId);
  if (!message || !delta) return;
  message.content += delta;
  touch(message, at);
}

export function setMessageOptions(
  projectId: string,
  messageId: string,
  options: string[],
  at: string,
): void {
  const message = findMessage(projectId, messageId);
  if (!message || options.length === 0) return;
  message.options = options.slice(0, 6);
  touch(message, at);
}

export function startThought(projectId: string, messageId: string, thought: Thought): void {
  const message = findMessage(projectId, messageId);
  if (!message) return;
  if (!message.thoughts) message.thoughts = [];
  message.thoughts.push(thought);
}

export function appendThoughtDelta(
  projectId: string,
  messageId: string,
  thoughtId: string,
  delta: string,
  at: string,
): void {
  const message = findMessage(projectId, messageId);
  const thought = message?.thoughts?.find((item) => item.id === thoughtId);
  if (!message || !thought || !delta) return;
  thought.text += delta;
  touch(message, at);
}

export function finishThought(
  projectId: string,
  messageId: string,
  thoughtId: string,
  at: string,
): void {
  const message = findMessage(projectId, messageId);
  const thought = message?.thoughts?.find((item) => item.id === thoughtId);
  if (!message || !thought) return;
  thought.finishedAt = at;
  touch(message, at);
}

export function appendStep(projectId: string, messageId: string, step: RunStep): void {
  const message = findMessage(projectId, messageId);
  if (!message) return;
  if (!message.steps) message.steps = [];
  message.steps.push(step);
}

export function updateStep(
  projectId: string,
  messageId: string,
  stepId: string,
  patch: { status?: RunStepStatus; detail?: string; at: string },
): void {
  const message = findMessage(projectId, messageId);
  const step = message?.steps?.find((item) => item.id === stepId);
  if (!message || !step) return;
  if (patch.status) {
    step.status = patch.status;
    if (patch.status === "running" && !step.startedAt) step.startedAt = patch.at;
    if (patch.status === "done" || patch.status === "failed") {
      step.finishedAt = patch.at;
    }
  }
  if (patch.detail !== undefined) step.detail = patch.detail;
  touch(message, patch.at);
}

export function appendBlock(
  projectId: string,
  messageId: string,
  block: ChatBlock,
  at: string,
): void {
  const message = findMessage(projectId, messageId);
  if (!message) return;
  if (!message.blocks) message.blocks = [];
  message.blocks.push(block);
  touch(message, at);
}

export function updateToolProgress(
  projectId: string,
  messageId: string,
  toolCallId: string,
  patch: { progress?: number; stage?: string; at: string },
): void {
  const message = findMessage(projectId, messageId);
  const tool = message?.blocks?.find(
    (item): item is ToolBlock => item.type === "tool" && item.id === toolCallId,
  );
  if (!message || !tool) return;
  if (tool.status === "queued") tool.status = "running";
  if (patch.progress !== undefined) tool.progress = patch.progress;
  if (patch.stage !== undefined) tool.stage = patch.stage;
  touch(message, patch.at);
}

export function updateToolStatus(
  projectId: string,
  messageId: string,
  toolCallId: string,
  status: ToolBlock["status"],
  detail: string | undefined,
  at: string,
): void {
  const message = findMessage(projectId, messageId);
  const tool = message?.blocks?.find(
    (item): item is ToolBlock => item.type === "tool" && item.id === toolCallId,
  );
  if (!message || !tool) return;
  tool.status = status;
  if (detail !== undefined) tool.detail = detail;
  if (status === "done") tool.progress = 100;
  if (status === "done" || status === "failed") tool.finishedAt = at;
  touch(message, at);
}

export function finishMessage(
  projectId: string,
  messageId: string,
  status: "completed" | "canceled" | "failed",
  at: string,
  error?: RunError,
): void {
  const message = findMessage(projectId, messageId);
  if (!message) return;
  message.status = status;
  touch(message, at);
  if (error) {
    message.error = error.message;
    message.failure = error;
  }
  // 收尾时把还在跑的工具和步骤标记掉，避免界面一直转圈
  for (const block of message.blocks ?? []) {
    if (block.type === "tool" && (block.status === "running" || block.status === "queued")) {
      block.status = status === "completed" ? "done" : "failed";
    }
  }
  for (const step of message.steps ?? []) {
    if (step.status === "running" || step.status === "pending") {
      step.status = status === "completed" ? "done" : "failed";
      step.finishedAt = at;
    }
  }
  for (const thought of message.thoughts ?? []) {
    if (!thought.finishedAt) thought.finishedAt = at;
  }
}

export function findUserPrompt(projectId: string, beforeMessageId?: string): string {
  const messages = ensureWorkspace(projectId).messages;
  const end = beforeMessageId ? messages.findIndex((m) => m.id === beforeMessageId) : messages.length;
  const limit = end === -1 ? messages.length : end;
  for (let index = limit - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.content.trim()) return message.content;
  }
  return "";
}

export const MAX_CONTEXT_MESSAGES = 20;