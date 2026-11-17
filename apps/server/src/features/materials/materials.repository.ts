import { randomUUID } from "node:crypto";
import { getDb } from "../../db/supabase.js";
import { env } from "../../lib/env.js";

export type UserMaterial = {
  id: string;
  name: string;
  url: string;
  /** /files/:id 背后的文件 id，删除素材时用来清 Storage */
  fileId: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  createdAt: string;
};

export type MaterialsRepository = {
  list(userId: string, limit?: number): Promise<UserMaterial[]>;
  save(userId: string, material: UserMaterial): Promise<void>;
  remove(userId: string, id: string): Promise<UserMaterial | null>;
};

type MaterialRow = {
  id: string;
  name: string;
  url: string;
  file_id: string;
  mime_type: string;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
};

const COLUMNS = "id, name, url, file_id, mime_type, size_bytes, width, height, created_at";

function toMaterial(row: MaterialRow): UserMaterial {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    fileId: row.file_id,
    mimeType: row.mime_type,
    size: Number(row.size_bytes ?? 0),
    width: row.width ?? 0,
    height: row.height ?? 0,
    createdAt: row.created_at,
  };
}

function createSupabaseMaterialsRepository(): MaterialsRepository {
  return {
    async list(userId, limit = 200) {
      const { data, error } = await getDb()
        .from("user_materials")
        .select(COLUMNS)
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as MaterialRow[]).map(toMaterial);
    },

    async save(userId, material) {
      const { error } = await getDb().from("user_materials").upsert({
        id: material.id,
        user_id: userId,
        name: material.name,
        url: material.url,
        file_id: material.fileId,
        mime_type: material.mimeType,
        size_bytes: material.size,
        width: material.width || null,
        height: material.height || null,
        created_at: material.createdAt,
      });
      if (error) throw error;
    },

    async remove(userId, id) {
      const { data, error } = await getDb()
        .from("user_materials")
        .delete()
        .eq("user_id", userId)
        .eq("id", id)
        .select(COLUMNS)
        .maybeSingle();
      if (error) throw error;
      return data ? toMaterial(data as MaterialRow) : null;
    },
  };
}

function createMemoryMaterialsRepository(): MaterialsRepository {
  const rows = new Map<string, UserMaterial & { userId: string }>();

  return {
    async list(userId, limit = 200) {
      return [...rows.values()]
        .filter((row) => row.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(({ userId: _ignored, ...material }) => material);
    },

    async save(userId, material) {
      rows.set(material.id, { ...material, userId });
    },

    async remove(userId, id) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) return null;
      rows.delete(id);
      const { userId: _ignored, ...material } = row;
      return material;
    },
  };
}

let repository: MaterialsRepository | null = null;

export function getMaterialsRepository(): MaterialsRepository {
  if (repository) return repository;
  repository =
    env.projectsStore === "supabase" && env.supabaseUrl && env.supabaseServiceKey
      ? createSupabaseMaterialsRepository()
      : createMemoryMaterialsRepository();
  return repository;
}

/** 测试用：强制使用内存实现，避免碰真实表。 */
export function createMemoryMaterialsRepositoryForTest(): MaterialsRepository {
  return createMemoryMaterialsRepository();
}

export function newMaterialId(): string {
  return randomUUID();
}