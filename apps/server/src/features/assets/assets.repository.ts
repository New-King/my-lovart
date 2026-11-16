import { getDb } from "../../db/supabase.js";
import { env } from "../../lib/env.js";
import type { ProjectAsset } from "./assets.js";

export type AssetsRepository = {
  save(projectId: string, asset: ProjectAsset): Promise<void>;
  list(projectId: string, limit?: number): Promise<ProjectAsset[]>;
  get(projectId: string, assetId: string): Promise<ProjectAsset | null>;
};

type AssetRow = {
  id: string;
  project_id: string;
  kind: "image" | "video";
  origin: "generated" | "uploaded" | "derived";
  title: string;
  prompt: string;
  model: string | null;
  provider: string | null;
  url: string;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  parent_asset_id: string | null;
  source_asset_ids: unknown;
  canvas_element_id: string | null;
  message_id: string | null;
  shot_id: string | null;
  metadata: unknown;
  created_at: string;
};

const COLUMNS =
  "id, project_id, kind, origin, title, prompt, model, provider, url, mime_type, width, height, duration_seconds, aspect_ratio, parent_asset_id, source_asset_ids, canvas_element_id, message_id, shot_id, metadata, created_at";

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toAsset(row: AssetRow): ProjectAsset {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    origin: row.origin,
    title: row.title,
    prompt: row.prompt ?? "",
    ...(row.model ? { model: row.model } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    url: row.url,
    mimeType: row.mime_type ?? "application/octet-stream",
    width: row.width ?? 0,
    height: row.height ?? 0,
    ...(row.duration_seconds ? { durationSeconds: row.duration_seconds } : {}),
    ...(row.aspect_ratio ? { aspectRatio: row.aspect_ratio } : {}),
    ...(row.parent_asset_id ? { parentAssetId: row.parent_asset_id } : {}),
    sourceAssetIds: toStringArray(row.source_asset_ids),
    ...(row.canvas_element_id ? { canvasElementId: row.canvas_element_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.shot_id ? { shotId: row.shot_id } : {}),
    metadata:
      typeof row.metadata === "object" && row.metadata !== null
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: row.created_at,
  };
}

function createSupabaseAssetsRepository(): AssetsRepository {
  return {
    async save(projectId, asset) {
      const { error } = await getDb().from("project_assets").upsert(
        {
          id: asset.id,
          project_id: projectId,
          kind: asset.kind,
          origin: asset.origin,
          title: asset.title,
          prompt: asset.prompt,
          model: asset.model ?? null,
          provider: asset.provider ?? null,
          url: asset.url,
          mime_type: asset.mimeType,
          width: asset.width || null,
          height: asset.height || null,
          duration_seconds: asset.durationSeconds ?? null,
          aspect_ratio: asset.aspectRatio ?? null,
          parent_asset_id: asset.parentAssetId ?? null,
          source_asset_ids: asset.sourceAssetIds,
          canvas_element_id: asset.canvasElementId ?? null,
          message_id: asset.messageId ?? null,
          shot_id: asset.shotId ?? null,
          metadata: asset.metadata,
          created_at: asset.createdAt,
        },
        { onConflict: "id" },
      );
      if (error) throw error;
    },

    async list(projectId, limit = 24) {
      const { data, error } = await getDb()
        .from("project_assets")
        .select(COLUMNS)
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as AssetRow[]).map(toAsset);
    },

    async get(projectId, assetId) {
      const { data, error } = await getDb()
        .from("project_assets")
        .select(COLUMNS)
        .eq("project_id", projectId)
        .eq("id", assetId)
        .maybeSingle();
      if (error) throw error;
      return data ? toAsset(data as AssetRow) : null;
    },
  };
}

function createMemoryAssetsRepository(): AssetsRepository {
  const store = new Map<string, ProjectAsset[]>();
  return {
    async save(projectId, asset) {
      const list = store.get(projectId) ?? [];
      const next = list.filter((item) => item.id !== asset.id);
      next.push(asset);
      store.set(projectId, next);
    },
    async list(projectId, limit = 24) {
      return [...(store.get(projectId) ?? [])]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
    async get(projectId, assetId) {
      return (store.get(projectId) ?? []).find((item) => item.id === assetId) ?? null;
    },
  };
}

let repository: Promise<AssetsRepository> | null = null;
let memoryRepository: AssetsRepository | null = null;
let warned = false;

/** 内存模式必须单例：每次调用都 new 会让资产账本、镜头指针全部丢失。 */
function memoryAssets(): AssetsRepository {
  memoryRepository ??= createMemoryAssetsRepository();
  return memoryRepository;
}

/**
 * 优先 Supabase；迁移未执行或连接失败时回落到内存，保证会话不中断。
 * 老消息里的 blocks 还会由 collectLegacyAssets 兜底。
 */
export function getAssetsRepository(): Promise<AssetsRepository> {
  if (env.projectsStore !== "supabase") return Promise.resolve(memoryAssets());
  if (repository) return repository;

  repository = (async () => {
    try {
      const { error } = await getDb().from("project_assets").select("id").limit(1);
      if (error) {
        if (!warned) {
          warned = true;
          console.warn(
            "[assets] 产物账本未启用：请先执行 supabase/migrations/0003_project_assets.sql",
          );
        }
        return memoryAssets();
      }
      return createSupabaseAssetsRepository();
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn("[assets] 产物账本初始化失败，回落到内存：", err);
      }
      return memoryAssets();
    }
  })();

  return repository;
}