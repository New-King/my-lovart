import { getDb } from "../../db/supabase.js";

export const STORAGE_BUCKET = "project-files";

let bucketReady: Promise<void> | null = null;

export async function ensureStorageBucket(): Promise<void> {
  if (bucketReady) return bucketReady;
  bucketReady = (async () => {
    const { error } = await getDb().storage.createBucket(STORAGE_BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message)) throw error;
  })().catch((err) => {
    bucketReady = null;
    throw err;
  });
  return bucketReady;
}

export async function uploadStoredFile(
  path: string,
  data: Buffer,
  mimeType: string,
): Promise<boolean> {
  try {
    await ensureStorageBucket();
    const { error } = await getDb()
      .storage.from(STORAGE_BUCKET)
      .upload(path, data, { contentType: mimeType, upsert: true });
    if (error) {
      console.warn(`[storage] 上传 ${path} 失败：`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[storage] 上传失败，保留内存副本：", err);
    return false;
  }
}

export async function downloadStoredFile(
  path: string,
): Promise<{ data: Buffer; mimeType: string } | null> {
  try {
    const { data, error } = await getDb().storage.from(STORAGE_BUCKET).download(path);
    if (error || !data) {
      if (error) console.warn(`[storage] 下载 ${path} 失败：`, error.message);
      return null;
    }
    return {
      data: Buffer.from(await data.arrayBuffer()),
      mimeType: data.type || "application/octet-stream",
    };
  } catch (err) {
    console.warn(`[storage] 下载 ${path} 异常：`, err);
    return null;
  }
}