import { randomUUID } from "node:crypto";
import type { InspirationItem } from "@my-lovart/shared";
import { env } from "../../lib/env.js";
import { GenerationError, isAbortError } from "../generation/types.js";

export type InspirationOrientation = "landscape" | "portrait" | "square";

export type InspirationSearchInput = {
  query: string;
  orientation?: InspirationOrientation;
  color?: string;
  perPage?: number;
  page?: number;
  signal?: AbortSignal;
};

type PexelsPhoto = {
  id?: number;
  width?: number;
  height?: number;
  url?: string;
  photographer?: string;
  photographer_url?: string;
  avg_color?: string;
  alt?: string;
  src?: Record<string, string | undefined>;
};

type PexelsResponse = {
  photos?: PexelsPhoto[];
  error?: string;
  message?: string;
};

const MAX_PER_PAGE = 6;

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Pexels 图片搜索。只做“公开灵感/方向参考”，不负责生成，也不承诺可执行身份。
 * 返回统一 InspirationItem，前端已有灵感卡片可预览、拖拽、加入对话。
 */
export async function searchPexelsPhotos(
  input: InspirationSearchInput,
): Promise<InspirationItem[]> {
  const query = input.query.trim();
  if (!query) {
    throw new GenerationError("invalid_search", "灵感搜索缺少关键词", false);
  }
  if (!env.pexelsApiKey) {
    throw new GenerationError(
      "invalid_config",
      "缺少 PEXELS_API_KEY，无法搜索灵感图。请在 .env.local 配置 Pexels API Key",
      false,
    );
  }

  const url = new URL(`${trimSlash(env.pexelsApiBase)}/search`);
  url.searchParams.set("query", query.slice(0, 120));
  url.searchParams.set("per_page", String(Math.min(MAX_PER_PAGE, Math.max(1, input.perPage ?? 4))));
  url.searchParams.set("page", String(Math.max(1, input.page ?? 1)));
  if (input.orientation) url.searchParams.set("orientation", input.orientation);
  if (input.color?.trim()) url.searchParams.set("color", input.color.trim());

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: env.pexelsApiKey,
        accept: "application/json",
        "user-agent": "my-lovart/0.1",
      },
      signal: input.signal,
    });
  } catch (err) {
    if (isAbortError(err, input.signal)) throw new GenerationError("aborted", "已停止搜索");
    throw new GenerationError("network_error", "连接 Pexels 失败，请稍后重试");
  }

  const raw = (await response.json().catch(() => null)) as PexelsResponse | null;
  if (!response.ok) {
    const message = raw?.error ?? raw?.message ?? "Pexels 搜索失败";
    throw new GenerationError(
      response.status === 401 || response.status === 403 ? "invalid_config" : "provider_error",
      `Pexels 返回 ${response.status}：${message}`.slice(0, 240),
      response.status === 429 || response.status >= 500,
    );
  }

  const photos = Array.isArray(raw?.photos) ? raw.photos : [];
  return photos.flatMap((photo): InspirationItem[] => {
    const src = photo.src ?? {};
    const imageUrl = firstUrl(
      src.large2x,
      src.large,
      src.original,
      src.medium,
      src.small,
      src.tiny,
    );
    if (!imageUrl) return [];
    const title =
      photo.alt?.trim() ||
      (photo.photographer
        ? `Photo by ${photo.photographer} on Pexels`
        : "Pexels 参考图");
    return [
      {
        id: photo.id ? `pexels-${photo.id}` : randomUUID(),
        title: title.slice(0, 120),
        imageUrl,
        source: photo.photographer ? `Pexels · ${photo.photographer}` : "Pexels",
        ...(photo.url ? { sourceUrl: photo.url } : {}),
        ...(typeof photo.width === "number" ? { width: photo.width } : {}),
        ...(typeof photo.height === "number" ? { height: photo.height } : {}),
      },
    ];
  });
}

function firstUrl(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && (trimmed.startsWith("https://") || trimmed.startsWith("http://"))) {
      return trimmed;
    }
  }
  return "";
}