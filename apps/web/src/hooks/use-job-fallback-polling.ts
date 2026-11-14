"use client";

import { useCallback, useEffect, useRef } from "react";
import { getJob, type BackgroundJob } from "@/lib/api";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 10 * 60 * 1_000;

/**
 * 工具在服务端等待超时后，worker 可能仍在跑。
 * 前端继续轮询 job，成功后刷新画布，避免结果和用户都“丢在半路”。
 */
export function useJobFallbackPolling(
  projectId: string | null,
  onSettled: (job: BackgroundJob) => void,
) {
  const timers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  const stop = useCallback((jobId: string) => {
    const timer = timers.current.get(jobId);
    if (timer) clearInterval(timer);
    timers.current.delete(jobId);
  }, []);

  const watchJob = useCallback(
    (jobId: string) => {
      const activeProject = projectRef.current;
      if (!activeProject || timers.current.has(jobId)) return;
      const startedAt = Date.now();

      const timer = setInterval(() => {
        if (Date.now() - startedAt > MAX_POLL_MS) {
          stop(jobId);
          return;
        }
        void getJob(activeProject, jobId)
          .then((job) => {
            if (job.status === "succeeded") {
              stop(jobId);
              settledRef.current(job);
            } else if (job.status === "failed" || job.status === "canceled") {
              stop(jobId);
              settledRef.current(job);
            }
          })
          .catch(() => {
            // 网络抖动不停止，下一次继续
          });
      }, POLL_INTERVAL_MS);

      timers.current.set(jobId, timer);
    },
    [stop],
  );

  useEffect(() => {
    const activeTimers = timers.current;
    return () => {
      for (const timer of activeTimers.values()) clearInterval(timer);
      activeTimers.clear();
    };
  }, []);

  return { watchJob };
}