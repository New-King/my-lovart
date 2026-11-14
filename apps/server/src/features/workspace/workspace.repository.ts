import type {
  ChatAttachment,
  ChatBlock,
  ChatMessage,
  MessagePart,
  RunError,
  RunStep,
  Thought,
} from "@my-lovart/shared";
import { getDb } from "../../db/supabase.js";
import { env } from "../../lib/env.js";
import { hydrateCanvasFiles, persistCanvasFiles } from "./canvas-file-store.js";
import type { Workspace } from "./workspace.store.js";

export type WorkspaceSnapshot = Pick<Workspace, "elements" | "files" | "messages">;

export type WorkspaceRepository = {
  load(projectId: string): Promise<WorkspaceSnapshot>;
  saveCanvas(projectId: string, elements: unknown[], files: Record<string, unknown>): Promise<void>;
  saveMessage(projectId: string, message: ChatMessage): Promise<void>;
};

type MessageRow = {
  id: string;
  role: string;
  content: string | null;
  blocks: unknown;
  parts: unknown;
  attachments: unknown;
  steps: unknown;
  thoughts: unknown;
  options: unknown;
  status: string | null;
  error: string | null;
  failure: unknown;
  created_at: string;
  updated_at: string | null;
};

const MESSAGE_COLUMNS =
  "id, role, content, blocks, parts, attachments, steps, thoughts, options, status, error, failure, created_at, updated_at";

function asArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) && value.length > 0 ? (value as T[]) : undefined;
}

function toMessage(row: MessageRow): ChatMessage | null {
  if (row.role !== "user" && row.role !== "assistant") return null;
  const status = ["queued", "streaming", "completed", "canceled", "failed"].includes(
    row.status ?? "",
  )
    ? (row.status as ChatMessage["status"])
    : undefined;

  return {
    id: row.id,
    role: row.role,
    content: row.content ?? "",
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    ...(status ? { status } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.failure ? { failure: row.failure as RunError } : {}),
    ...(asArray<ChatAttachment>(row.attachments) ? { attachments: asArray<ChatAttachment>(row.attachments) } : {}),
    ...(asArray<ChatBlock>(row.blocks) ? { blocks: asArray<ChatBlock>(row.blocks) } : {}),
    ...(asArray<MessagePart>(row.parts) ? { parts: asArray<MessagePart>(row.parts) } : {}),
    ...(asArray<RunStep>(row.steps) ? { steps: asArray<RunStep>(row.steps) } : {}),
    ...(asArray<Thought>(row.thoughts) ? { thoughts: asArray<Thought>(row.thoughts) } : {}),
    ...(asArray<string>(row.options) ? { options: asArray<string>(row.options) } : {}),
  };
}

function createSupabaseWorkspaceRepository(): WorkspaceRepository {
  const db = () => getDb();

  async function ensureSession(projectId: string): Promise<string> {
    const { data, error } = await db()
      .from("sessions")
      .select("id")
      .eq("project_id", projectId)
      .maybeSingle();
    if (error) throw error;
    if (data?.id) return data.id as string;

    const inserted = await db()
      .from("sessions")
      .insert({ project_id: projectId, title: "主对话" })
      .select("id")
      .single();
    if (!inserted.error && inserted.data?.id) return inserted.data.id as string;

    // 并发插入被唯一索引拦下时，重新读一次
    if (inserted.error?.code === "23505") {
      const retry = await db()
        .from("sessions")
        .select("id")
        .eq("project_id", projectId)
        .maybeSingle();
      if (!retry.error && retry.data?.id) return retry.data.id as string;
    }
    throw inserted.error ?? new Error("无法创建会话");
  }

  async function ensureCanvas(projectId: string) {
    const { data, error } = await db()
      .from("canvases")
      .select("id, elements, files")
      .eq("project_id", projectId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data as { id: string; elements: unknown; files: unknown };

    const inserted = await db()
      .from("canvases")
      .insert({ project_id: projectId, elements: [], files: {} })
      .select("id, elements, files")
      .single();
    if (!inserted.error && inserted.data) {
      return inserted.data as { id: string; elements: unknown; files: unknown };
    }
    if (inserted.error?.code === "23505") {
      const retry = await db()
        .from("canvases")
        .select("id, elements, files")
        .eq("project_id", projectId)
        .maybeSingle();
      if (!retry.error && retry.data) {
        return retry.data as { id: string; elements: unknown; files: unknown };
      }
    }
    throw inserted.error ?? new Error("无法创建画布");
  }

  return {
    async load(projectId) {
      const [sessionId, canvas] = await Promise.all([
        ensureSession(projectId),
        ensureCanvas(projectId),
      ]);
      const { data, error } = await db()
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });
      if (error) throw error;

      return {
        elements: Array.isArray(canvas.elements) ? (canvas.elements as unknown[]) : [],
        files: await hydrateCanvasFiles(
          typeof canvas.files === "object" && canvas.files !== null && !Array.isArray(canvas.files)
            ? (canvas.files as Record<string, unknown>)
            : {},
        ),
        messages: ((data ?? []) as MessageRow[])
          .map(toMessage)
          .filter((message): message is ChatMessage => message !== null),
      };
    },

    async saveCanvas(projectId, elements, files) {
      const canvas = await ensureCanvas(projectId);
      const manifest = await persistCanvasFiles(
        projectId,
        files,
        typeof canvas.files === "object" && canvas.files !== null && !Array.isArray(canvas.files)
          ? (canvas.files as Record<string, unknown>)
          : {},
      );
      const { error } = await db()
        .from("canvases")
        .update({ elements, files: manifest, updated_at: new Date().toISOString() })
        .eq("id", canvas.id);
      if (error) throw error;
    },

    async saveMessage(projectId, message) {
      const sessionId = await ensureSession(projectId);
      const { error } = await db().from("messages").upsert(
        {
          id: message.id,
          session_id: sessionId,
          role: message.role,
          content: message.content,
          blocks: message.blocks ?? [],
          parts: message.parts ?? [],
          attachments: message.attachments ?? [],
          steps: message.steps ?? [],
          thoughts: message.thoughts ?? [],
          options: message.options ?? [],
          status: message.status ?? "completed",
          error: message.error ?? null,
          failure: message.failure ?? null,
          created_at: message.createdAt,
          updated_at: message.updatedAt ?? new Date().toISOString(),
        },
        { onConflict: "id" },
      );
      if (error) throw error;
    },
  };
}

let repositoryPromise: Promise<WorkspaceRepository | null> | null = null;

/**
 * 只有在 schema 0002 已执行、且 Supabase 可用时才启用持久化。
 * 没迁移时回落到内存，保证本地仍能跑；日志会明确提示。
 */
export function getWorkspaceRepository(): Promise<WorkspaceRepository | null> {
  if (env.projectsStore !== "supabase") return Promise.resolve(null);
  if (repositoryPromise) return repositoryPromise;

  repositoryPromise = (async () => {
    const repo = createSupabaseWorkspaceRepository();
    try {
      const { error } = await getDb()
        .from("messages")
        .select("id, parts, status, updated_at")
        .limit(1);
      if (error) {
        console.warn(
          "[workspace] 消息持久化未启用：请先执行 supabase/migrations/0002_workspace_persistence.sql",
        );
        return null;
      }
      const canvasCheck = await getDb().from("canvases").select("id, files").limit(1);
      if (canvasCheck.error) {
        console.warn(
          "[workspace] 画布持久化未启用：请先执行 supabase/migrations/0002_workspace_persistence.sql",
        );
        return null;
      }
      return repo;
    } catch (err) {
      console.warn("[workspace] 持久化初始化失败，回落到内存：", err instanceof Error ? err.message : err);
      return null;
    }
  })();

  return repositoryPromise;
}