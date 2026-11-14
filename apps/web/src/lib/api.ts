import type {
  AspectRatio,
  ChatAttachment,
  ChatMessage,
  GenerateRequest,
  RunEvent,
} from "@my-lovart/shared";

export type {
  AspectRatio,
  ChatAttachment,
  ChatBlock,
  ChatMessage,
  GenerateRequest,
  RunEvent,
} from "@my-lovart/shared";

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 只存在于前端：还没落库的草稿 */
  isDraft?: boolean;
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
  generation: "mock" | "real";
  uptime: number;
};

export async function getHealth(): Promise<AgentHealth> {
  const res = await fetch(`${base}/health`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /health ${res.status}`);
  return (await res.json()) as AgentHealth;
}

async function authToken(): Promise<string | null> {
  const { getAccessToken } = await import("./auth");
  let token = await getAccessToken();
  // 登录跳转后 Supabase 客户端可能还没从 storage 恢复会话，等一拍再取
  if (!token) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    token = await getAccessToken();
  }
  return token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await authToken();
  // 没有 body 的请求不能带 content-type: application/json，
  // Fastify 会以 FST_ERR_CTP_EMPTY_JSON_BODY 拒掉整条请求
  const hasBody = init?.body !== undefined && init.body !== null;

  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
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

/**
 * POST 一条 SSE 流。服务端每个事件一行 `data: {...}`。
 * 客户端中止（停止按钮/切项目）由 AbortSignal 完成，服务端会按取消收尾。
 */
async function streamRun(
  path: string,
  body: unknown,
  onEvent: (event: RunEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const token = await authToken();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} ${res.status} ${text}`);
  }
  if (!res.body) throw new Error("服务端没有返回事件流");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as RunEvent);
        } catch {
          // 单个畸形事件不影响整条流
        }
      }
    }
  }
}

export const listProjects = () => request<Project[]>("/projects");

export const createProject = (name: string) =>
  request<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) });

export const renameProject = (id: string, name: string) =>
  request<Project>(`/projects/${id}/rename`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });

export const deleteProject = (id: string) =>
  request<void>(`/projects/${id}/delete`, { method: "POST" });

export const autoNameProject = (id: string, prompt: string) =>
  request<Project>(`/projects/${id}/auto-name`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });

export const getWorkspace = (projectId: string) =>
  request<WorkspaceData>(`/workspace/${projectId}`);

export const saveCanvas = (
  projectId: string,
  elements: unknown[],
  files: Record<string, unknown>,
) =>
  request<void>(`/workspace/${projectId}/canvas`, {
    method: "POST",
    body: JSON.stringify({ elements, files }),
  });

export function sendMessageStream(
  projectId: string,
  input: { text: string; attachments: ChatAttachment[]; aspectRatio?: AspectRatio },
  onEvent: (event: RunEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamRun(
    `/workspace/${projectId}/messages`,
    {
      text: input.text,
      attachments: input.attachments,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    },
    onEvent,
    signal,
  );
}

export function generateStream(
  projectId: string,
  input: GenerateRequest,
  onEvent: (event: RunEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamRun(`/workspace/${projectId}/generate`, input, onEvent, signal);
}