import type { AspectRatio } from "@my-lovart/shared";
import { env } from "../../lib/env.js";
import {
  GenerationError,
  isAbortError,
  sleep,
  type VideoGenerationInput,
  type VideoGenerationResult,
  type VideoModelInfo,
  type VideoProvider,
} from "./types.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 300_000;

const ALLOWED_RATIOS: AspectRatio[] = ["16:9", "4:3", "1:1", "3:4", "9:16"];

const KNOWN_MODELS: VideoModelInfo[] = [
  {
    id: "MiniMax-H3",
    displayName: "MiniMax H3",
    description: "MiniMax H3，支持 4-15 秒、首尾帧和参考图，当前默认视频模型",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      firstLastFrame: true,
      referenceImages: true,
    },
    limits: { minDuration: 4, maxDuration: 15, maxInputImages: 2, maxResolution: "1080p" },
    defaultDurationSeconds: 8,
    available: true,
  },
  {
    id: "MiniMax-Highspeed",
    displayName: "MiniMax Highspeed",
    description: "MiniMax 高速档，4-15 秒，适合快速草稿",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      firstLastFrame: true,
      referenceImages: true,
    },
    limits: { minDuration: 4, maxDuration: 15, maxInputImages: 2, maxResolution: "1080p" },
    defaultDurationSeconds: 8,
    available: true,
  },
  {
    id: "MiniMax-Lite",
    displayName: "MiniMax Lite",
    description: "MiniMax 轻量档，4-15 秒，成本更低",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      firstLastFrame: true,
      referenceImages: true,
    },
    limits: { minDuration: 4, maxDuration: 15, maxInputImages: 2, maxResolution: "1080p" },
    defaultDurationSeconds: 8,
    available: true,
  },
  {
    id: "MiniMax-Max",
    displayName: "MiniMax Max",
    description: "MiniMax 高质量档，5-15 秒，适合最终成片",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      firstLastFrame: true,
      referenceImages: true,
    },
    limits: { minDuration: 5, maxDuration: 15, maxInputImages: 2, maxResolution: "1080p" },
    defaultDurationSeconds: 8,
    available: true,
  },
];

type CreateResponse = { task_id?: unknown };
type TaskResponse = {
  task?: {
    id?: unknown;
    status?: unknown;
    content?: { url?: unknown } | null;
    error?: { code?: unknown; message?: unknown } | null;
    duration?: unknown;
    resolution?: unknown;
    ratio?: unknown;
    modality?: unknown;
  };
  error?: { message?: unknown; type?: unknown };
  request_id?: unknown;
};

function models(): readonly VideoModelInfo[] {
  if (!env.videoModel) return KNOWN_MODELS;
  if (KNOWN_MODELS.some((model) => model.id === env.videoModel)) return KNOWN_MODELS;
  return [
    ...KNOWN_MODELS,
    {
      id: env.videoModel,
      displayName: env.videoModel,
      description: "由环境变量 VIDEO_MODEL 配置的 Metaso/MiniMax 模型",
      capabilities: {
        textToVideo: true,
        imageToVideo: true,
        firstLastFrame: true,
        referenceImages: true,
      },
      limits: { minDuration: 4, maxDuration: 15, maxInputImages: 2, maxResolution: "1080p" },
      defaultDurationSeconds: 8,
    },
  ];
}

function modelInfo(modelId: string): VideoModelInfo {
  return models().find((model) => model.id === modelId) ?? KNOWN_MODELS[0]!;
}

export async function generateWithMetasoVideo(
  input: VideoGenerationInput & { model: string },
): Promise<VideoGenerationResult> {
  if (!env.metasoApiKey) {
    throw new GenerationError("invalid_config", "缺少 METASO_API_KEY，无法生成视频", false);
  }

  const info = modelInfo(input.model);
  const aspectRatio: AspectRatio = ALLOWED_RATIOS.includes(input.aspectRatio)
    ? input.aspectRatio
    : "16:9";
  const duration = clampDuration(
    input.durationSeconds ?? info.defaultDurationSeconds,
    info.limits.minDuration,
    info.limits.maxDuration,
  );
  const resolution = input.resolution ?? env.videoResolution;
  const providerResolution = toProviderResolution(resolution);
  const images = (input.referenceImages ?? []).slice(0, info.limits.maxInputImages);

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: input.prompt.slice(0, 7000) },
  ];
  if (images[0]) {
    content.push({ type: "image_url", image_url: { url: images[0] }, role: "first_frame" });
  }
  if (images[1]) {
    content.push({ type: "image_url", image_url: { url: images[1] }, role: "last_frame" });
  }

  input.onProgress?.(8, "提交任务");

  const created = (await requestJson("v2/video_generation", {
    method: "POST",
    body: JSON.stringify({
      model: input.model,
      content,
      resolution: providerResolution,
      duration,
      ratio: images.length > 0 ? "adaptive" : aspectRatio,
    }),
    signal: input.signal,
  })) as CreateResponse;

  const taskId = typeof created.task_id === "string" ? created.task_id.trim() : "";
  if (!taskId) throw new GenerationError("malformed_response", "Metaso 没有返回 task_id");

  const deadline = Date.now() + MAX_WAIT_MS;
  let progress = 12;

  while (Date.now() < deadline) {
    if (input.signal?.aborted) {
      await cancelTask(taskId);
      throw new GenerationError("aborted", "已停止生成");
    }

    const response = (await requestJson(
      `v2/query/video_generation/${encodeURIComponent(taskId)}`,
      { method: "GET", signal: input.signal },
    )) as TaskResponse;
    const task = (response.task ?? {}) as NonNullable<TaskResponse["task"]>;
    const status = typeof task?.status === "string" ? task.status : "";

    if (status === "succeeded") {
      const url = typeof task?.content?.url === "string" ? task.content.url : "";
      if (!url) throw new GenerationError("no_output", "Metaso 没有返回视频地址");
      if (task?.modality != null && task.modality !== "video") {
        throw new GenerationError("malformed_response", "Metaso 返回的不是视频结果");
      }

      const finalDuration =
        Number.isInteger(task?.duration) && (task.duration as number) > 0
          ? (task.duration as number)
          : duration;
      const size = estimateSize(resolution, aspectRatio);

      input.onProgress?.(92, "下载结果");
      return {
        url,
        mimeType: "video/mp4",
        ...size,
        durationSeconds: finalDuration,
        provider: "metaso",
        model: input.model,
        modelDisplayName: info.displayName,
      };
    }

    if (status === "failed") {
      const code = typeof task?.error?.code === "string" ? task.error.code : "provider_error";
      const message =
        typeof task?.error?.message === "string"
          ? task.error.message
          : "Metaso 视频生成失败";
      throw new GenerationError(code.slice(0, 60), message.slice(0, 300), false);
    }

    if (status === "cancelled") {
      throw new GenerationError("canceled", "视频任务已取消", true);
    }

    if (status !== "queued" && status !== "running") {
      throw new GenerationError("malformed_response", `Metaso 返回未知状态：${status}`);
    }

    progress = Math.min(88, progress + 6);
    input.onProgress?.(progress, status === "queued" ? "排队中" : "渲染中");
    await sleep(POLL_INTERVAL_MS, input.signal);
  }

  await cancelTask(taskId);
  throw new GenerationError("timeout", "视频生成超时，请重试", true);
}

async function cancelTask(taskId: string): Promise<void> {
  try {
    await requestJson(`v2/video_generation/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
    });
  } catch {
    // 尽力而为：任务可能已经进入渲染阶段，无法再取消
  }
}

async function requestJson(
  path: string,
  init: { method: string; body?: string; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(new URL(path, withTrailingSlash(env.metasoApiBase)), {
      method: init.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.metasoApiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: init.signal,
    });
  } catch (err) {
    if (isAbortError(err, init.signal)) throw new GenerationError("aborted", "已停止生成");
    throw new GenerationError("network_error", "连接 Metaso 失败，请稍后重试");
  }

  const body = (await response.json().catch(() => null)) as TaskResponse | null;

  if (!response.ok) {
    const message =
      typeof body?.error?.message === "string" ? body.error.message : "Metaso 请求失败";
    const retriable = response.status === 429 || response.status >= 500;
    throw new GenerationError(
      response.status === 401 || response.status === 402 ? "invalid_config" : "provider_error",
      `Metaso 返回 ${response.status}：${message}`.slice(0, 320),
      retriable,
    );
  }

  if (!body || typeof body !== "object") {
    throw new GenerationError("malformed_response", "Metaso 返回了非对象响应");
  }
  return body as Record<string, unknown>;
}

function clampDuration(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return Math.min(max, Math.max(min, 8));
  return Math.min(max, Math.max(min, Math.round(value)));
}

function toProviderResolution(value: "480p" | "720p" | "1080p"): string {
  if (value === "1080p") return "1080P";
  if (value === "480p") return "512P";
  return "768P";
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function estimateSize(
  resolution: "480p" | "720p" | "1080p",
  ratio: AspectRatio,
): { width: number; height: number } {
  const shortSide = resolution === "1080p" ? 1080 : resolution === "480p" ? 512 : 768;
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) return { width: shortSide, height: shortSide };
  const value = w / h;
  if (value >= 1) {
    return { width: Math.round(shortSide * value), height: shortSide };
  }
  return { width: shortSide, height: Math.round(shortSide / value) };
}

export const metasoVideoProvider: VideoProvider = {
  name: "metaso",
  models: models(),
  generate: generateWithMetasoVideo,
};