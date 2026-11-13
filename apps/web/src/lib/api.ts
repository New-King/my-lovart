import type { ChatBlock } from "@my-lovart/shared";

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 只存在于前端：还没落库的草稿 */
  isDraft?: boolean;
};

export type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  /** 前端本地预览用 data URL；接上存储后换成远端地址 */
  url: string;
  size: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments?: ChatAttachment[];
  blocks?: ChatBlock[];
};

export type WorkspaceData = {
  projectId: string;
  elements: unknown[];
  files?: Record<string, unknown>;
  messages: ChatMessage[];
};

const base = process.env.NEXT_PUBLIC_SERVER_BASE_URL ?? "http://127.0.0.1:3001";

export type AgentHealth = {
  ok: boolean;
  name: string;
  store: "memory" | "supabase";
  agent: "mock" | "llm";
  uptime: number;
};

export async function getHealth(): Promise<AgentHealth> {
  const res = await fetch(`${base}/health`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /health ${res.status}`);
  return (await res.json()) as AgentHealth;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { getAccessToken } = await import("./auth");
  let token = await getAccessToken();

  // 登录跳转后 Supabase 客户端可能还没从 storage 恢复会话，等一拍再取
  if (!token) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    token = await getAccessToken();
  }

  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init?.method ?? "GET"} ${path} ${res.status} ${body}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const listProjects = () => request<Project[]>("/projects");

export const createProject = (name: string) =>
  request<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) });

export const getWorkspace = (projectId: string) =>
  request<WorkspaceData>(`/workspace/${projectId}`);

export const saveCanvas = (
  projectId: string,
  elements: unknown[],
  files: Record<string, unknown>,
) =>
  request<void>(`/workspace/${projectId}/canvas`, {
    method: "PUT",
    body: JSON.stringify({ elements, files }),
  });

export const sendMessage = (projectId: string, text: string) =>
  request<WorkspaceData>(`/workspace/${projectId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });