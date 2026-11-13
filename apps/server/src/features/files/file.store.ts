import { randomUUID } from "node:crypto";
import type { ChatAttachment } from "@my-lovart/shared";

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
export function normalizeAttachment(
  input: RawAttachment,
  baseUrl: string,
): ChatAttachment | null {
  const url = typeof input.url === "string" ? input.url : "";
  if (!url) return null;

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

export function getFile(id: string): StoredFile | undefined {
  return files.get(id);
}