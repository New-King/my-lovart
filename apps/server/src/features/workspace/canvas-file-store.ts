import {
  downloadStoredFile,
  uploadStoredFile,
} from "../files/storage.js";

type CanvasFileValue = {
  id?: string;
  mimeType?: string;
  dataURL?: string;
  created?: number;
  lastRetrieved?: number;
  path?: string;
};

function parseDataUrl(dataURL: string): { mimeType: string; data: Buffer } | null {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataURL);
  if (!match) return null;
  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  const data = isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  return data.byteLength > 0 ? { mimeType, data } : null;
}

/**
 * Excalidraw 的 files 里是完整 data URL，几 MB 一张。落 Supabase Storage，
 * canvases.files 只存 manifest；加载时再拼回 dataURL 给前端。
 * 上传失败的文件保留 dataURL 作为兜底，不让画布保存失败。
 */
export async function persistCanvasFiles(
  projectId: string,
  files: Record<string, unknown>,
  existing: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const entries = Object.entries(files);
  if (entries.length === 0) return {};

  const manifest: Record<string, unknown> = {};

  for (const [id, raw] of entries) {
    const file = raw as CanvasFileValue;
    const previous = existing[id] as CanvasFileValue | undefined;
    // fileId 是 Excalidraw 根据文件内容生成的；已经上传过就直接复用
    if (previous?.path) {
      manifest[id] = previous;
      continue;
    }

    const dataURL = typeof file.dataURL === "string" ? file.dataURL : "";
    if (!dataURL.startsWith("data:")) {
      manifest[id] = raw;
      continue;
    }

    const parsed = parseDataUrl(dataURL);
    if (!parsed) {
      manifest[id] = raw;
      continue;
    }

    const path = `${projectId}/${id}`;
    const uploaded = await uploadStoredFile(
      path,
      parsed.data,
      file.mimeType || parsed.mimeType,
    );
    if (!uploaded) {
      manifest[id] = raw;
      continue;
    }

    manifest[id] = {
      id,
      mimeType: file.mimeType || parsed.mimeType,
      ...(typeof file.created === "number" ? { created: file.created } : {}),
      ...(typeof file.lastRetrieved === "number" ? { lastRetrieved: file.lastRetrieved } : {}),
      path,
    };
  }

  return manifest;
}

/** 把 manifest 里的路径下载成 dataURL；老的 dataURL 条目原样返回 */
export async function hydrateCanvasFiles(
  files: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(files);
  if (entries.length === 0) return {};

  const result: Record<string, unknown> = {};

  await Promise.all(
    entries.map(async ([id, raw]) => {
      const file = raw as CanvasFileValue;
      if (typeof file.dataURL === "string" && file.dataURL.startsWith("data:")) {
        result[id] = raw;
        return;
      }
      if (typeof file.path !== "string" || !file.path) {
        result[id] = raw;
        return;
      }

      const downloaded = await downloadStoredFile(file.path);
      if (!downloaded) {
        result[id] = raw;
        return;
      }
      result[id] = {
        id,
        mimeType: file.mimeType || downloaded.mimeType,
        dataURL: `data:${file.mimeType || downloaded.mimeType};base64,${downloaded.data.toString("base64")}`,
        ...(typeof file.created === "number" ? { created: file.created } : {}),
        ...(typeof file.lastRetrieved === "number" ? { lastRetrieved: file.lastRetrieved } : {}),
      };
    }),
  );

  return result;
}