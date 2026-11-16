import type { AspectRatio } from "@my-lovart/shared";

/** 统一的模型元数据。provider 只负责翻译参数，不把厂商字段泄漏到业务层。 */
export type ModelInfo = {
  /** provider 内稳定的 model id，例如 doubao-seedream-4-5-251128 */
  id: string;
  /** 给用户看的名字，例如 Seedream 4.5 */
  displayName: string;
  /** 给 Agent / 后台选择用的短说明 */
  description: string;
  /** 是否处于可用状态；额度耗尽时可保留元数据但置为 false */
  available?: boolean;
};

export type ImageQuality = "standard" | "hd" | "ultra";

export type ImageModelInfo = ModelInfo & {
  /** 是否支持参考图/图生图 */
  supportsReferenceImages: boolean;
  /** 一次最多参考几张图；不支持时为 0 */
  maxReferenceImages: number;
  /** semantic 表示 provider 接受 "1K/2K/4K"，pixel 表示必须传 WxH */
  sizeMode: "semantic" | "pixel";
  /** 该模型实际支持的清晰度档位；请求不支持的档位时 provider 向上取可用档 */
  qualities: readonly ImageQuality[];
};

export type VideoModelInfo = ModelInfo & {
  capabilities: {
    textToVideo: boolean;
    imageToVideo: boolean;
    firstLastFrame: boolean;
    referenceImages: boolean;
  };
  limits: {
    minDuration: number;
    maxDuration: number;
    maxInputImages: number;
    maxResolution: "480p" | "720p" | "1080p";
  };
  defaultDurationSeconds: number;
};

export type ImageGenerationInput = {
  prompt: string;
  aspectRatio: AspectRatio;
  /** HTTP(S) 地址或 data:image/...;base64, */
  referenceImages?: string[];
  /** 不传走服务端默认模型；传了必须能被某个已注册 provider 解析 */
  model?: string;
  /** 不传走 provider 默认档位 */
  quality?: ImageQuality;
  signal?: AbortSignal;
};

export type ImageGenerationResult = {
  url: string;
  mimeType: string;
  width: number;
  height: number;
  provider: string;
  model: string;
  modelDisplayName: string;
};

export type VideoGenerationInput = {
  prompt: string;
  aspectRatio: AspectRatio;
  durationSeconds?: number;
  /** 首帧 / 尾帧，最多两张；不同 provider 能力见 VideoModelInfo */
  referenceImages?: string[];
  model?: string;
  resolution?: "480p" | "720p" | "1080p";
  signal?: AbortSignal;
  onProgress?: (progress: number, stage: string) => void;
};

export type VideoGenerationResult = {
  url: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
  provider: string;
  model: string;
  modelDisplayName: string;
};

/** 每个 provider 适配器的统一接口。新增厂商只需实现它并注册。 */
export type ImageProvider = {
  readonly name: string;
  readonly models: readonly ImageModelInfo[];
  generate(input: ImageGenerationInput & { model: string }): Promise<ImageGenerationResult>;
};

export type VideoProvider = {
  readonly name: string;
  readonly models: readonly VideoModelInfo[];
  generate(input: VideoGenerationInput & { model: string }): Promise<VideoGenerationResult>;
};

/** 供应商返回的结构化错误，服务端按 code 决定 retriable 和前端文案 */
export class GenerationError extends Error {
  readonly code: string;
  readonly retriable: boolean;

  constructor(code: string, message: string, retriable = true) {
    super(message);
    this.name = "GenerationError";
    this.code = code;
    this.retriable = retriable;
  }
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

export function abortError(): GenerationError {
  return new GenerationError("aborted", "已停止生成", true);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}