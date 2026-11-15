import { getDb } from "../../db/supabase.js";
import { env } from "../../lib/env.js";

export type JobType = "image_generation" | "video_generation";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type BackgroundJob = {
  id: string;
  projectId: string;
  sessionId?: string;
  threadId?: string;
  jobType: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  progress: number;
  stage?: string;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  canceledAt?: string;
};

type JobRow = {
  id: string;
  project_id: string;
  session_id: string | null;
  thread_id: string | null;
  job_type: JobType;
  status: JobStatus;
  payload: unknown;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  progress: number | null;
  stage: string | null;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  canceled_at: string | null;
};

const COLUMNS =
  "id, project_id, session_id, thread_id, job_type, status, payload, result, error_code, error_message, progress, stage, attempt_count, max_attempts, created_at, started_at, completed_at, failed_at, canceled_at";

function toJob(row: JobRow): BackgroundJob {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    jobType: row.job_type,
    status: row.status,
    payload: record(row.payload) ?? {},
    ...(row.result ? { result: record(row.result) } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    progress: Math.min(100, Math.max(0, Number(row.progress ?? 0))),
    ...(row.stage ? { stage: row.stage } : {}),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.failed_at ? { failedAt: row.failed_at } : {}),
    ...(row.canceled_at ? { canceledAt: row.canceled_at } : {}),
  };
}

export function jobsEnabled(): boolean {
  return env.generationMode === "real" && env.projectsStore === "supabase" && Boolean(env.supabaseDbUrl);
}

export type CreateJobInput = {
  projectId: string;
  type: JobType;
  payload: Record<string, unknown>;
  sessionId?: string;
  threadId?: string;
  maxAttempts?: number;
};

export async function createJob(input: CreateJobInput): Promise<BackgroundJob> {
  const { data, error } = await getDb()
    .from("background_jobs")
    .insert({
      project_id: input.projectId,
      session_id: input.sessionId ?? null,
      thread_id: input.threadId ?? null,
      job_type: input.type,
      payload: input.payload,
      max_attempts: input.maxAttempts ?? 3,
    })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return toJob(data as JobRow);
}

export async function getJob(
  projectId: string,
  jobId: string,
): Promise<BackgroundJob | null> {
  const { data, error } = await getDb()
    .from("background_jobs")
    .select(COLUMNS)
    .eq("project_id", projectId)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  return data ? toJob(data as JobRow) : null;
}

export async function cancelJob(projectId: string, jobId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await getDb()
    .from("background_jobs")
    .update({ status: "canceled", canceled_at: now })
    .eq("project_id", projectId)
    .eq("id", jobId)
    .in("status", ["queued", "running"])
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function updateJobProgress(
  projectId: string,
  jobId: string,
  progress: number,
  stage?: string,
): Promise<void> {
  const value = Math.min(100, Math.max(0, Math.round(progress)));
  const { error } = await getDb()
    .from("background_jobs")
    .update({ progress: value, ...(stage ? { stage: stage.slice(0, 60) } : {}) })
    .eq("project_id", projectId)
    .eq("id", jobId)
    .eq("status", "running");
  if (error) throw error;
}

export async function claimNextJob(): Promise<BackgroundJob | null> {
  const { data, error } = await getDb().rpc("claim_background_job");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? toJob(row as JobRow) : null;
}

export async function markJobSucceeded(
  jobId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const { error } = await getDb()
    .from("background_jobs")
    .update({
      status: "succeeded",
      result,
      progress: 100,
      stage: "完成",
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "running");
  if (error) throw error;
}

export async function markJobFailed(
  job: BackgroundJob,
  code: string,
  message: string,
): Promise<"queued" | "failed"> {
  const db = getDb();
  const retry = job.attemptCount < job.maxAttempts;
  if (retry) {
    const { error } = await db
      .from("background_jobs")
      .update({
        status: "queued",
        error_code: code,
        error_message: message.slice(0, 1000),
        progress: 0,
        stage: null,
        started_at: null,
      })
      .eq("id", job.id);
    if (error) throw error;
    return "queued";
  }
  const { error } = await db
    .from("background_jobs")
    .update({
      status: "failed",
      error_code: code,
      error_message: message.slice(0, 1000),
      failed_at: new Date().toISOString(),
    })
    .eq("id", job.id);
  if (error) throw error;
  return "failed";
}

export async function waitForJob(
  projectId: string,
  jobId: string,
  options: {
    timeoutMs: number;
    signal: AbortSignal;
    onProgress?: (job: BackgroundJob) => void;
  },
): Promise<BackgroundJob | null> {
  const deadline = Date.now() + options.timeoutMs;
  let lastProgress = -1;
  let lastStage: string | undefined;
  while (Date.now() < deadline) {
    if (options.signal.aborted) return null;
    const job = await getJob(projectId, jobId);
    if (!job) return null;
    if (job.progress !== lastProgress || job.stage !== lastStage) {
      lastProgress = job.progress;
      lastStage = job.stage;
      options.onProgress?.(job);
    }
    if (job.status === "succeeded" || job.status === "failed" || job.status === "canceled") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return getJob(projectId, jobId);
}