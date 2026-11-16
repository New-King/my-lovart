import type { AspectRatio } from "@my-lovart/shared";
import { env } from "../../lib/env.js";
import {
  GenerationError,
  isAbortError,
  type ImageGenerationInput,
  type ImageGenerationResult,
  type ImageModelInfo,
  type ImageProvider,
  type ImageQuality,
} from "./types.js";

export const SEEDREAM_45_MODEL_ID = "doubao-seedream-4-5-251128";
export const SEEDREAM_5_LITE_MODEL_ID = "doubao-seedream-5-0-260128";
export const SEEDREAM_40_MODEL_ID = "doubao-seedream-4-0-250828";

const KNOWN_MODELS: ImageModelInfo[] = [
  {
    id: SEEDREAM_45_MODEL_ID,
    displayName: "Seedream 4.5",
    description: "火山方舟 Seedream 4.5，支持 2K/4K、参考图，当前默认生图模型",
    supportsReferenceImages: true,
    maxReferenceImages: 10,
    sizeMode: "semantic",
    qualities: ["hd", "ultra"],
    available: true,
  },
  {
    id: SEEDREAM_5_LITE_MODEL_ID,
    displayName: "Seedream 5.0 Lite",
    description: "火山方舟 Seedream 5.0 Lite，必须传像素尺寸，参考图最多 10 张",
    supportsReferenceImages: true,
    maxReferenceImages: 10,
    sizeMode: "pixel",
    qualities: ["standard", "hd", "ultra"],
    available: true,
  },
  {
    id: SEEDREAM_40_MODEL_ID,
    displayName: "Seedream 4.0",
    description: "火山方舟 Seedream 4.0，兼容旧项目的像素尺寸接口",
    supportsReferenceImages: true,
    maxReferenceImages: 10,
    sizeMode: "pixel",
    qualities: ["standard", "hd", "ultra"],
    available: true,
  },
];

/** Seedream 5.0 Lite 的 method-2 尺寸：必须显式 WxH。 */
const PIXEL_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 2048, height: 2048 },
  "4:3": { width: 2304, height: 1728 },
  "3:4": { width: 1728, height: 2304 },
  "16:9": { width: 2560, height: 1440 },
  "9:16": { width: 1440, height: 2560 },
};

const LONG_SIDE: Record<ImageQuality, number> = {
  standard: 1024,
  hd: 2048,
  ultra: 4096,
};

const SEMANTIC_SIZE: Record<ImageQuality, string> = {
  standard: "1K",
  hd: "2K",
  ultra: "4K",
};

const QUALITY_ORDER: ImageQuality[] = ["standard", "hd", "ultra"];

function supportedQuality(
  info: ImageModelInfo,
  requested: ImageQuality,
): ImageQuality {
  if (info.qualities.includes(requested)) return requested;
  const start = QUALITY_ORDER.indexOf(requested);
  for (const candidate of QUALITY_ORDER.slice(Math.max(0, start))) {
    if (info.qualities.includes(candidate)) return candidate;
  }
  return info.qualities[info.qualities.length - 1] ?? "hd";
}

/** 方式 1（size: 2K/4K）需要 prompt 说明画幅，否则模型会按默认 4:3 构图。 */
function withAspectInstruction(prompt: string, aspectRatio: AspectRatio): string {
  return `${prompt}\n\n画面比例：${aspectRatio}。请严格按 ${aspectRatio} 画幅构图，不要输出其他比例。`;
}

type VolcesResponse = {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string; code?: string };
};

function models(): readonly ImageModelInfo[] {
  if (!env.volcesImageModel) return KNOWN_MODELS;
  if (KNOWN_MODELS.some((model) => model.id === env.volcesImageModel)) return KNOWN_MODELS;
  return [
    ...KNOWN_MODELS,
    {
      id: env.volcesImageModel,
      displayName: env.volcesImageModel,
      description: "由环境变量 IMAGE_MODEL 配置的 Seedream 模型",
      supportsReferenceImages: true,
      maxReferenceImages: 10,
      sizeMode: "pixel",
      qualities: ["standard", "hd", "ultra"],
    },
  ];
}

function modelInfo(modelId: string): ImageModelInfo {
  return models().find((model) => model.id === modelId) ?? KNOWN_MODELS[0]!;
}

function resolveSize(
  model: ImageModelInfo,
  aspectRatio: AspectRatio,
  quality: ImageQuality,
): { request: string; width: number; height: number } {
  if (model.sizeMode === "semantic") {
    const longSide = LONG_SIDE[quality];
    return {
      request: SEMANTIC_SIZE[quality],
      ...estimateDimensions(aspectRatio, longSide),
    };
  }
  const fixed = PIXEL_SIZES[aspectRatio] ?? PIXEL_SIZES["1:1"];
  return {
    request: `${fixed.width}x${fixed.height}`,
    width: fixed.width,
    height: fixed.height,
  };
}

function estimateDimensions(
  aspectRatio: AspectRatio,
  longSide: number,
): { width: number; height: number } {
  const [w, h] = aspectRatio.split(":").map(Number);
  if (!w || !h) return { width: longSide, height: longSide };
  const ratio = w / h;
  if (ratio >= 1) {
    return { width: longSide, height: Math.round(longSide / ratio) };
  }
  return { width: Math.round(longSide * ratio), height: longSide };
}

function normalizeReferences(
  images: string[] | undefined,
  max: number,
): string | string[] | undefined {
  const refs = (images ?? [])
    .map((item) => item.trim())
    .filter(
      (item) =>
        item.startsWith("http://") ||
        item.startsWith("https://") ||
        item.startsWith("data:image/"),
    )
    .slice(0, max);

  if (refs.length === 0) return undefined;
  return refs.length === 1 ? refs[0] : refs;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function generateWithVolcesImage(
  input: ImageGenerationInput & { model: string },
): Promise<ImageGenerationResult> {
  if (!env.arkApiKey) {
    throw new GenerationError(
      "invalid_config",
      "缺少 ARK_API_KEY（或历史变量 VOLCES_API_KEY），无法生成图片",
      false,
    );
  }

  const info = modelInfo(input.model);
  const quality = supportedQuality(info, input.quality ?? env.imageQuality);
  const size = resolveSize(info, input.aspectRatio, quality);
  const body: Record<string, unknown> = {
    model: input.model,
    prompt:
      info.sizeMode === "semantic"
        ? withAspectInstruction(input.prompt, input.aspectRatio)
        : input.prompt,
    sequential_image_generation: "disabled",
    response_format: "url",
    size: size.request,
    stream: false,
    // 平台水印默认关闭；需要时用 ARK_IMAGE_WATERMARK=true 打开
    watermark: env.imageWatermark,
  };

  const references = normalizeReferences(
    input.referenceImages,
    info.maxReferenceImages,
  );
  if (references) body.image = references;

  let response: Response;
  try {
    response = await fetch(`${trimSlash(env.arkApiBase)}/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.arkApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (err) {
    if (isAbortError(err, input.signal)) throw new GenerationError("aborted", "已停止生成");
    throw new GenerationError("network_error", "连接火山方舟失败，请稍后重试");
  }

  const raw = (await response.json().catch(() => null)) as VolcesResponse | null;

  if (!response.ok) {
    const detail = raw?.error?.message ? `：${raw.error.message}` : "";
    const retriable = response.status === 429 || response.status >= 500;
    throw new GenerationError(
      response.status === 401 ? "invalid_config" : "provider_error",
      `火山方舟返回 ${response.status}${detail}`.slice(0, 320),
      retriable,
    );
  }

  const data = raw?.data?.[0];
  if (!data?.url) {
    throw new GenerationError("no_output", "火山方舟没有返回图片地址");
  }

  return {
    url: data.url,
    mimeType: "image/png",
    width: size.width,
    height: size.height,
    provider: "volces",
    model: input.model,
    modelDisplayName: info.displayName,
  };
}

export const volcesImageProvider: ImageProvider = {
  name: "volces",
  models: models(),
  generate: generateWithVolcesImage,
};