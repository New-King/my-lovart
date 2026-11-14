import type { AspectRatio } from "@my-lovart/shared";

export type ImageGenerationInput = {
  prompt: string;
  aspectRatio: AspectRatio;
  /** HTTP(S) 地址或 data:image/...;base64, */
  referenceImages?: string[];
  signal?: AbortSignal;
};

export type ImageGenerationResult = {
  url: string;
  mimeType: string;
  width: number;
  height: number;
};

export type VideoGenerationInput = {
  prompt: string;
  aspectRatio: AspectRatio;
  durationSeconds?: number;
  /** 首帧 / 尾帧，最多两张 */
  referenceImages?: string[];
  signal?: AbortSignal;
  onProgress?: (progress: number, stage: string) => void;
};

export type VideoGenerationResult = {
  url: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
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