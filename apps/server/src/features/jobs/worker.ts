import { randomUUID } from "node:crypto";
import type { ImageBlock, VideoBlock } from "@my-lovart/shared";
import { getDb } from "../../db/supabase.js";
import { env } from "../../lib/env.js";
import { getAssetsRepository } from "../assets/assets.repository.js";
import type { ProjectAsset } from "../assets/assets.js";
import { insertImageOnCanvas, insertVideoOnCanvas } from "../canvas/server-canvas.js";
import { importRemoteFile } from "../files/file.store.js";
import { generateVideoWithMetaso } from "../generation/metaso-video.js";
import { GenerationError } from "../generation/types.js";
import { generateImageWithVolces } from "../generation/volces-image.js";
import { getStoryboardsRepository } from "../storyboards/storyboards.repository.js";
import {
  claimNextJob,
  getJob,
  jobsEnabled,
  markJobFailed,
  markJobSucceeded,
  updateJobProgress,
  type BackgroundJob,
} from "./jobs.js";

class JobCanceledError extends Error {
  constructor() {
    super("作业已取消");
    this.name = "JobCanceledError";
  }
}

let started = false;
let active = 0;
const MAX_CONCURRENT = 2;

async function reportProgress(
  job: BackgroundJob,
  progress: number,
  stage: string,
): Promise<void> {
  await updateJobProgress(job.projectId, job.id, progress, stage).catch((err) => {
    console.warn(
      "[worker] 进度写库失败：",
      err instanceof Error ? err.message : err,
    );
  });
}

async function attachToShot(
  projectId: string,
  shotId: string,
  assetId: string,
): Promise<void> {
  if (!shotId) return;
  try {
    const repo = await getStoryboardsRepository();
    await repo.applyAssetToShot(projectId, shotId, assetId);
  } catch (err) {
    console.warn(
      "[worker] 资产挂分镜失败：",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * 作业有自己的超时和取消：
 * - 用户在页面上取消 → jobs.status=canceled，这里 abort provider
 * - 超时 → 抛 TimeoutError，交给 execute 标记 job_timeout
 */
async function runJobGeneration<T>(
  job: BackgroundJob,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([timeout, controller.signal]);
  let stopped = false;

  const timer = setInterval(() => {
    void getJob(job.projectId, job.id)
      .then((current) => {
        if (!stopped && current?.status === "canceled") {
          stopped = true;
          controller.abort();
        }
      })
      .catch(() => undefined);
  }, 2_000);

  try {
    return await run(signal);
  } catch (err) {
    if (controller.signal.aborted) throw new JobCanceledError();
    if (timeout.aborted) {
      throw Object.assign(new Error("生成超时"), { name: "TimeoutError" });
    }
    throw err;
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

function assetFromArtifact(
  projectId: string,
  artifact: ImageBlock | VideoBlock,
): ProjectAsset {
  return {
    id: artifact.id,
    projectId,
    kind: artifact.type,
    origin: "generated",
    title:
      artifact.title?.trim() ||
      artifact.prompt?.trim().slice(0, 40) ||
      (artifact.type === "video" ? "未命名视频" : "未命名图片"),
    prompt: artifact.prompt ?? "",
    ...(artifact.model ? { model: artifact.model } : {}),
    url: artifact.url,
    mimeType: artifact.mimeType,
    width: artifact.width,
    height: artifact.height,
    ...(artifact.type === "video" && artifact.durationSeconds
      ? { durationSeconds: artifact.durationSeconds }
      : {}),
    ...(artifact.type === "image" && artifact.aspectRatio
      ? { aspectRatio: artifact.aspectRatio }
      : {}),
    sourceAssetIds: artifact.sourceAssetIds ?? [],
    ...(artifact.shotId ? { shotId: artifact.shotId } : {}),
    metadata: { job: true },
    createdAt: new Date().toISOString(),
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function executeImageJob(job: BackgroundJob): Promise<Record<string, unknown>> {
  const payload = job.payload;
  const prompt = asString(payload.prompt);
  const title = asString(payload.title) || prompt.slice(0, 30) || "生成图像";
  const shotId = asString(payload.shotId);
  if (!prompt) throw new Error("job payload 缺少 prompt");

  const inputImages = Array.isArray(payload.inputImages)
    ? payload.inputImages.filter((item): item is string => typeof item === "string")
    : [];
  const sourceAssetIds = Array.isArray(payload.sourceAssetIds)
    ? payload.sourceAssetIds.filter((item): item is string => typeof item === "string")
    : [];

  await reportProgress(job, 12, "提交 Seedream");
  const result = await runJobGeneration(job, 5 * 60_000, (signal) =>
    generateImageWithVolces({
      prompt,
      aspectRatio: (asString(payload.aspectRatio) || "3:4") as "1:1" | "4:3" | "3:4" | "16:9" | "9:16",
      referenceImages: inputImages,
      signal,
    }),
  );
  if ((await getJob(job.projectId, job.id))?.status === "canceled") {
    throw new JobCanceledError();
  }

  await reportProgress(job, 82, "下载结果");
  const stored = await importRemoteFile(result.url, `http://127.0.0.1:${env.port}`, {
    name: title,
    fallbackMimeType: result.mimeType,
  }).catch(() => null);

  const artifact: ImageBlock = {
    type: "image",
    id: randomUUID(),
    url: stored?.url ?? result.url,
    mimeType: stored?.mimeType ?? result.mimeType,
    width: result.width,
    height: result.height,
    title,
    prompt: prompt.slice(0, 2000),
    model: "Seedream 5.0 Lite",
    aspectRatio: asString(payload.aspectRatio) || "3:4",
    sourceAssetIds,
    ...(shotId ? { shotId } : {}),
  };

  await reportProgress(job, 92, "落画布");
  const placed = await insertImageOnCanvas({
    projectId: job.projectId,
    assetId: artifact.id,
    title,
    prompt,
    url: artifact.url,
    mimeType: artifact.mimeType,
    width: artifact.width,
    height: artifact.height,
    ...(typeof payload.batchId === "string" ? { batchId: payload.batchId } : {}),
  }).catch((err) => {
    console.warn("[worker] 图片上画布失败：", err instanceof Error ? err.message : err);
    return null;
  });

  if (placed) {
    artifact.elementId = placed.elementId;
    artifact.placement = placed.placement;
  }

  await getAssetsRepository()
    .then((repo) => repo.save(job.projectId, assetFromArtifact(job.projectId, artifact)))
    .catch((err) => {
      console.warn("[worker] 资产落账本失败：", err instanceof Error ? err.message : err);
    });

  if (shotId) await attachToShot(job.projectId, shotId, artifact.id);

  return { artifact, jobId: job.id, ...(placed ? { elementId: placed.elementId, placement: placed.placement } : {}) };
}

async function executeVideoJob(job: BackgroundJob): Promise<Record<string, unknown>> {
  const payload = job.payload;
  const prompt = asString(payload.prompt);
  const title = asString(payload.title) || prompt.slice(0, 30) || "生成视频";
  const shotId = asString(payload.shotId);
  if (!prompt) throw new Error("job payload 缺少 prompt");
  const inputImages = Array.isArray(payload.inputImages)
    ? payload.inputImages.filter((item): item is string => typeof item === "string").slice(0, 2)
    : [];
  const sourceAssetIds = Array.isArray(payload.sourceAssetIds)
    ? payload.sourceAssetIds.filter((item): item is string => typeof item === "string")
    : [];

  await reportProgress(job, 8, "提交任务");
  const result = await runJobGeneration(job, 10 * 60_000, (signal) =>
    generateVideoWithMetaso({
      prompt,
      aspectRatio: (asString(payload.aspectRatio) || "16:9") as "1:1" | "4:3" | "3:4" | "16:9" | "9:16",
      durationSeconds: asNumber(payload.durationSeconds) ?? 8,
      referenceImages: inputImages,
      signal,
      onProgress: (progress, stage) => {
        void reportProgress(job, progress, stage);
      },
    }),
  );
  if ((await getJob(job.projectId, job.id))?.status === "canceled") {
    throw new JobCanceledError();
  }

  await reportProgress(job, 92, "下载结果");
  const stored = await importRemoteFile(result.url, `http://127.0.0.1:${env.port}`, {
    name: title,
    fallbackMimeType: result.mimeType,
  }).catch(() => null);

  const artifact: VideoBlock = {
    type: "video",
    id: randomUUID(),
    url: stored?.url ?? result.url,
    mimeType: stored?.mimeType ?? result.mimeType,
    width: result.width,
    height: result.height,
    durationSeconds: result.durationSeconds,
    title,
    prompt: prompt.slice(0, 2000),
    model: "MiniMax H3",
    sourceAssetIds,
    ...(shotId ? { shotId } : {}),
  };

  await reportProgress(job, 94, "落画布");
  const placed = await insertVideoOnCanvas({
    projectId: job.projectId,
    assetId: artifact.id,
    title,
    prompt,
    url: artifact.url,
    mimeType: artifact.mimeType,
    width: artifact.width,
    height: artifact.height,
    ...(artifact.durationSeconds !== undefined
      ? { durationSeconds: artifact.durationSeconds }
      : {}),
    ...(typeof payload.batchId === "string" ? { batchId: payload.batchId } : {}),
  }).catch((err) => {
    console.warn("[worker] 视频上画布失败：", err instanceof Error ? err.message : err);
    return null;
  });

  if (placed) {
    artifact.elementId = placed.elementId;
    artifact.placement = placed.placement;
  }

  await getAssetsRepository()
    .then((repo) => repo.save(job.projectId, assetFromArtifact(job.projectId, artifact)))
    .catch((err) => {
      console.warn("[worker] 视频资产落账本失败：", err instanceof Error ? err.message : err);
    });

  if (shotId) await attachToShot(job.projectId, shotId, artifact.id);

  return {
    artifact,
    jobId: job.id,
    ...(placed ? { elementId: placed.elementId, placement: placed.placement } : {}),
  };
}

async function execute(job: BackgroundJob): Promise<void> {
  const startedAt = Date.now();
  console.log(`[worker] 开始 ${job.jobType} ${job.id} attempt=${job.attemptCount}`);
  try {
    const result =
      job.jobType === "image_generation"
        ? await executeImageJob(job)
        : await executeVideoJob(job);
    await markJobSucceeded(job.id, result);
    console.log(`[worker] 完成 ${job.id} +${Date.now() - startedAt}ms`);
  } catch (err) {
    if (err instanceof JobCanceledError) {
      console.log(`[worker] 已取消 ${job.id}`);
      return;
    }
    const latest = await getJob(job.projectId, job.id).catch(() => null);
    if (latest?.status === "canceled") {
      console.log(`[worker] 已取消（忽略收尾错误）${job.id}`);
      return;
    }
    if (
      (err instanceof Error && err.name === "TimeoutError") ||
      (err instanceof GenerationError && err.code === "timeout")
    ) {
      await markJobFailed(job, "job_timeout", "生成超时，可重试");
      return;
    }
    const code = err instanceof GenerationError ? err.code : "job_error";
    const message = err instanceof Error ? err.message : "作业执行失败";
    console.error(`[worker] 失败 ${job.id}:`, message);
    await markJobFailed(job, code, message);
  }
}

async function tick(): Promise<void> {
  if (active >= MAX_CONCURRENT) return;
  active += 1;
  try {
    const job = await claimNextJob();
    if (job) {
      void execute(job).finally(() => {
        active = Math.max(0, active - 1);
      });
    } else {
      active = Math.max(0, active - 1);
    }
  } catch (err) {
    active = Math.max(0, active - 1);
    console.warn("[worker] 领取作业失败：", err instanceof Error ? err.message : err);
  }
}

export async function startJobWorker(): Promise<void> {
  if (started) return;
  if (!jobsEnabled()) {
    console.log("[worker] 未启用（generationMode != real 或队列不可用）");
    return;
  }
  try {
    const { error } = await getDb().from("background_jobs").select("id").limit(1);
    if (error) {
      console.warn(
        "[worker] 未启动：请先执行 supabase/migrations/0005_background_jobs.sql",
      );
      return;
    }
  } catch (err) {
    console.warn("[worker] 未启动：", err instanceof Error ? err.message : err);
    return;
  }
  started = true;
  console.log("[worker] 生成作业 worker 已启动");
  void tick();
  setInterval(() => {
    void tick();
  }, 1000);
}