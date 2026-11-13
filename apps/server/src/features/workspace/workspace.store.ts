import { randomUUID } from "node:crypto";
import type { ChatBlock } from "@my-lovart/shared";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  blocks?: ChatBlock[];
};

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
  blocks?: ChatBlock[],
): ChatMessage {
  const ws = ensureWorkspace(projectId);
  const message: ChatMessage = {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(blocks && blocks.length > 0 ? { blocks } : {}),
  };
  ws.messages.push(message);
  return message;
}

export const MAX_CONTEXT_MESSAGES = 20;