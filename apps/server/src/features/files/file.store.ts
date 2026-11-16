import { randomUUID } from "node:crypto";
import type { ChatAttachment } from "@my-lovart/shared";
import { downloadStoredFile, uploadStoredFile } from "./storage.js";

type StoredFile = {
  id: string;
  name: string;
  mimeType: string;
  data: Buffer;
};

/**
 * 内存文件仓库：附件以 data URL 上传，落成 /files/:id 地址后再写进消息，
 * 这样刷新页面仍然拿得到图片，消息本身也不会背着几 MB 的 base64。
 * 之后接 Supabase Storage 时只替换这一层。
 */
const files = new Map<string, StoredFile>();

const MAX_FILE_BYTES = 12 * 1024 * 1024;

export const FILE_ROUTE_PREFIX = "/files/";

type RawAttachment = {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  url?: unknown;
  size?: unknown;
  width?: unknown;
  height?: unknown;
};

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 把客户端附件转成可持久化的形态：
 * - data URL 写入文件仓库，返回绝对地址
 * - 已经是地址（/mock/*.svg、http(s)）的原样保留
 */
export async function normalizeAttachment(
  input: RawAttachment,
  baseUrl: string,
): Promise<ChatAttachment | null> {
  const url = typeof input.url === "string" ? input.url : "";
  if (!url) return null;
  // blob:/file: 只在本机这个页面进程里有效，服务端和模型都拿不到，
  // 必须在客户端先转成 data URL；这里拒掉，避免静默变成「模型没收到图」。
  if (url.startsWith("blob:") || url.startsWith("file:")) return null;

  const name = asString(input.name, "图片");

  if (!url.startsWith("data:")) {
    return {
      id: asString(input.id, randomUUID()),
      name,
      mimeType: asString(input.mimeType, "image/png"),
      url,
      size: typeof input.size === "number" ? input.size : 0,
      ...(asNumber(input.width) ? { width: asNumber(input.width) } : {}),
      ...(asNumber(input.height) ? { height: asNumber(input.height) } : {}),
    };
  }

  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) return null;

  const mimeType = match[1] || asString(input.mimeType, "image/png");
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  const data = isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");

  if (data.byteLength === 0 || data.byteLength > MAX_FILE_BYTES) return null;

  const id = randomUUID();
  files.set(id, { id, name, mimeType, data });
  await uploadStoredFile(`attachments/${id}`, data, mimeType);

  return {
    id,
    name,
    mimeType,
    url: `${baseUrl}${FILE_ROUTE_PREFIX}${id}`,
    size: data.byteLength,
    ...(asNumber(input.width) ? { width: asNumber(input.width) } : {}),
    ...(asNumber(input.height) ? { height: asNumber(input.height) } : {}),
  };
}

/** 服务端自己产出的文件（如视频抽帧）：直接落内存 + Storage，返回 /files/:id */
export async function importFileBuffer(
  data: Buffer,
  mimeType: string,
  name: string,
  baseUrl: string,
): Promise<{ id: string; url: string; size: number }> {
  if (data.byteLength === 0) throw new Error("文件为空");
  if (data.byteLength > MAX_IMPORT_BYTES) throw new Error("文件超过 64MB");
  const id = randomUUID();
  files.set(id, { id, name, mimeType, data });
  await uploadStoredFile(`attachments/${id}`, data, mimeType);
  return { id, url: `${baseUrl}${FILE_ROUTE_PREFIX}${id}`, size: data.byteLength };
}

export async function getFile(id: string): Promise<StoredFile | undefined> {
  const cached = files.get(id);
  if (cached) return cached;

  const downloaded = await downloadStoredFile(`attachments/${id}`);
  if (!downloaded) return undefined;
  const stored: StoredFile = {
    id,
    name: "file",
    mimeType: downloaded.mimeType,
    data: downloaded.data,
  };
  files.set(id, stored);
  return stored;
}

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** 生成结果先落盘，避免供应商的临时 URL 过期后画布打不开 */
export async function importRemoteFile(
  url: string,
  baseUrl: string,
  options: { name: string; fallbackMimeType: string },
): Promise<{ url: string; mimeType: string; size: number }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载生成结果失败（HTTP ${response.status}）`);

  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength === 0) throw new Error("生成结果为空");
  if (data.byteLength > MAX_IMPORT_BYTES) throw new Error("生成结果超过 64MB");

  const mimeType =
    response.headers.get("content-type")?.split(";")[0]?.trim() ||
    options.fallbackMimeType;
  const id = randomUUID();
  files.set(id, { id, name: options.name, mimeType, data });
  await uploadStoredFile(`attachments/${id}`, data, mimeType);

  return {
    url: `${baseUrl}${FILE_ROUTE_PREFIX}${id}`,
    mimeType,
    size: data.byteLength,
  };
}

/** 供应商要求可公网访问的图片；本地附件转成 data URL 再送过去 */
export async function fileDataUrlFromUrl(url: string): Promise<string | undefined> {
  if (!url.startsWith("data:")) {
    const index = url.indexOf(FILE_ROUTE_PREFIX);
    if (index < 0) return undefined;
    const id = url.slice(index + FILE_ROUTE_PREFIX.length).split(/[?#]/)[0];
    if (!id) return undefined;
    const file = await getFile(id);
    if (!file) return undefined;
    return `data:${file.mimeType};base64,${file.data.toString("base64")}`;
  }
  return url;
}