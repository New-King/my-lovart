// @ts-ignore 可选依赖：未安装时运行时会走 disabled 分支
import pg from "pg";
// @ts-ignore 可选依赖：未安装时运行时会走 disabled 分支
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { env } from "../../../lib/env.js";

/**
 * LangGraph 执行记忆。
 * 和产品消息/画布持久化是两回事：checkpointer 保存 thread 里的完整
 * messages（含 AI tool_calls 与 ToolMessage），用于跨轮/跨进程恢复工具细节。
 */

const SCHEMA = "langgraph";
const POOL_MAX = 3;

export type CheckpointerStatus = {
  status: "idle" | "ready" | "disabled" | "error";
  host?: string;
  detail?: string;
};

let status: CheckpointerStatus = { status: "idle" };
let checkpointerPromise: Promise<PostgresSaver | null> | null = null;
let activePool: {
  query: (text: string, values: unknown[]) => Promise<unknown>;
} | null = null;

export function getCheckpointerStatus(): CheckpointerStatus {
  return status;
}

/** Supabase 直连 db.<ref>.supabase.co 常常只有 IPv6；优先走 pooler。 */
function candidateUrls(): string[] {
  const urls: string[] = [];
  const explicitPooler = process.env.SUPABASE_DB_POOLER_URL;
  if (explicitPooler) urls.push(explicitPooler);

  const raw = env.supabaseDbUrl;
  if (!raw) return urls;

  try {
    const parsed = new URL(raw);
    const ref = /^db\.([^.]+)\.supabase\.co$/.exec(parsed.hostname)?.[1];
    if (ref) {
      const pooler = new URL(raw);
      pooler.hostname = "aws-1-ap-northeast-1.pooler.supabase.com";
      pooler.port = "5432";
      pooler.username = `postgres.${ref}`;
      urls.push(pooler.toString());
    }
  } catch {
    // 不是标准 URL 时直接原样尝试
  }

  urls.push(raw);
  return [...new Set(urls)];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

async function initCheckpointer(): Promise<PostgresSaver | null> {
  const urls = candidateUrls();
  if (urls.length === 0) {
    status = { status: "disabled", detail: "SUPABASE_DB_URL 未配置" };
    console.warn("[checkpointer] 未配置数据库地址，执行记忆关闭");
    return null;
  }

  let lastError: unknown;
  for (const url of urls) {
    const pool = new pg.Pool({
      connectionString: url,
      max: POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    });
    pool.on("error", (err: Error) => {
      console.error("[checkpointer-pool] idle client error:", err.message);
    });

    try {
      const checkpointer = new PostgresSaver(pool, undefined, { schema: SCHEMA });
      await checkpointer.setup();
      activePool = pool as unknown as typeof activePool;
      status = { status: "ready", host: hostOf(url) };
      console.log(`[checkpointer] 已连接 ${hostOf(url)}，schema=${SCHEMA}`);
      return checkpointer;
    } catch (err) {
      lastError = err;
      await pool.end().catch(() => undefined);
    }
  }

  status = {
    status: "error",
    detail: lastError instanceof Error ? lastError.message : String(lastError),
  };
  console.warn(
    "[checkpointer] 初始化失败，本轮退化为无执行记忆：",
    status.detail,
  );
  return null;
}

export function getCheckpointer(): Promise<PostgresSaver | null> {
  if (!checkpointerPromise) {
    checkpointerPromise = initCheckpointer().catch((err) => {
      status = {
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      };
      return null;
    });
  }
  return checkpointerPromise;
}

/** 删除项目时清掉对应 thread，避免 langgraph schema 里留下孤儿数据。 */
export async function deleteThreadCheckpoints(threadId: string): Promise<void> {
  if (!activePool) return;
  for (const table of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]) {
    await activePool.query(`delete from langgraph.${table} where thread_id = $1`, [threadId]);
  }
}