import type { AspectRatio } from "@my-lovart/shared";
import { env } from "../../lib/env.js";
import {
  GenerationError,
  isAbortError,
  type ImageGenerationInput,
  type ImageGenerationResult,
} from "./types.js";

/**
 * Seedream 5.0 Lite 的 method-2 尺寸：必须显式 WxH，
 * 总像素在 2560×1440 与 4096×4096 之间，宽高比 1/16–16。
 * 这里按常用比例给出 2K 档的合法尺寸，避免每次算浮点边界。
 */
const SEEDREAM_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 2048, height: 2048 },
  "4:3": { width: 2304, height: 1728 },
  "3:4": { width: 1728, height: 2304 },
  "16:9": { width: 2560, height: 1440 },
  "9:16": { width: 1440, height: 2560 },
};

type VolcesResponse = {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string; code?: string };
};

export async function generateImageWithVolces(
  input: ImageGenerationInput,
): Promise<ImageGenerationResult> {
  if (!env.volcesApiKey) {
    throw new GenerationError("invalid_config", "缺少 VOLCES_API_KEY，无法生成图片", false);
  }

  const { width, height } = SEEDREAM_SIZES[input.aspectRatio] ?? SEEDREAM_SIZES["1:1"];
  const body: Record<string, unknown> = {
    model: env.volcesImageModel,
    prompt: input.prompt,
    sequential_image_generation: "disabled",
    response_format: "url",
    size: `${width}x${height}`,
    stream: false,
    // 打开会带平台水印；产品自己要控制品牌，这里关闭
    watermark: false,
  };

  const references = normalizeReferences(input.referenceImages);
  if (references) body.image = references;

  let response: Response;
  try {
    response = await fetch(`${trimSlash(env.volcesApiBase)}/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.volcesApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (err) {
    if (isAbortError(err, input.signal)) throw new GenerationError("aborted", "已停止生成");
    throw new GenerationError("network_error", "连接 Volces 失败，请稍后重试");
  }

  const raw = (await response.json().catch(() => null)) as VolcesResponse | null;

  if (!response.ok) {
    const detail = raw?.error?.message ? `：${raw.error.message}` : "";
    const retriable = response.status === 429 || response.status >= 500;
    throw new GenerationError(
      response.status === 401 ? "invalid_config" : "provider_error",
      `Volces 返回 ${response.status}${detail}`,
      retriable,
    );
  }

  const data = raw?.data?.[0];
  if (!data?.url) {
    throw new GenerationError("no_output", "Volces 没有返回图片地址");
  }

  return {
    url: data.url,
    mimeType: "image/png",
    width,
    height,
  };
}

function normalizeReferences(images?: string[]): string | string[] | undefined {
  const refs = (images ?? [])
    .map((item) => item.trim())
    .filter((item) => item.startsWith("http://") || item.startsWith("https://") || item.startsWith("data:image/"))
    .slice(0, 10);

  if (refs.length === 0) return undefined;
  return refs.length === 1 ? refs[0] : refs;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}