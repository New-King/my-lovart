import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * 每次运行一个 JSONL trace，落到仓库根目录 `.traces/`。
 * 目的：出问题时能完整看到「请求带了什么附件 → 归一化成了什么 → 模型收到了什么 → 工具做了什么」，
 * 不再靠猜。trace 里不放 base64、token、API key。
 */

function findRepoRoot(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const TRACE_DIR =
  process.env.TRACE_DIR ?? path.join(findRepoRoot(import.meta.dirname), ".traces");

const MAX_STRING = 4000;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") {
    if (value.startsWith("data:")) {
      return `[data-url ${value.length} chars]`;
    }
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length} chars]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/authorization|api[-_]?key|token|secret|dataurl/i.test(key)) {
        result[key] = "[redacted]";
      } else {
        result[key] = sanitize(item, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

export type Trace = {
  runId: string;
  file: string;
  event(stage: string, data?: Record<string, unknown>): void;
};

export function createTrace(runId: string, meta: Record<string, unknown> = {}): Trace {
  mkdirSync(TRACE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(TRACE_DIR, `${stamp}-${runId}.jsonl`);

  const write = (stage: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      runId,
      pid: process.pid,
      stage,
      ...(data ? { data: sanitize(data) } : {}),
    });
    try {
      appendFileSync(file, `${line}\n`);
    } catch (err) {
      console.warn("[trace] 写入失败：", err instanceof Error ? err.message : err);
    }
  };

  write("trace.start", meta);
  return { runId, file, event: write };
}