/**
 * 素材库端到端验收：真实 Supabase 表 + Storage + HTTP 路由 + JWT。
 *
 * 不碰用户密码：用 service_role 生成魔法链接，再用 hashed_token 换 session，
 * 拿到真实 access token 后走 app.inject（不依赖 dev server 是否在跑）。
 *
 * 用法：pnpm --filter @my-lovart/server verify:materials
 */
import { randomUUID } from "node:crypto";

process.env.PROJECTS_STORE = "supabase";

const { buildApp } = await import("../dist/app.js");
const { getDb } = await import("../dist/db/supabase.js");
const { env } = await import("../dist/lib/env.js");
const { createClient } = await import("@supabase/supabase-js");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;

async function tokenFor(email) {
  const db = getDb();
  const { data: link, error: linkError } = await db.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError) throw linkError;
  const hashed = link.properties?.hashed_token;
  if (!hashed) throw new Error("没有拿到 hashed_token");

  // 关键：换 session 必须用独立 auth client。如果在 getDb() 上 verifyOtp，
  // supabase-js 会把 service_role 客户端切成用户会话，之后 Storage 上传会吃 RLS 403。
  const authClient = createClient(
    env.supabaseUrl,
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: verified, error: verifyError } = await authClient.auth.verifyOtp({
    token_hash: hashed,
    type: "magiclink",
  });
  if (verifyError) throw verifyError;
  const token = verified.session?.access_token;
  if (!token) throw new Error("没有拿到 access token");
  return { token, userId: verified.user?.id };
}

const email = process.env.MATERIALS_TEST_EMAIL || "newking@example.com";
let app;
let createdId = "";

try {
  const auth = await tokenFor(email);
  app = buildApp();
  await app.ready();

  const headers = { authorization: `Bearer ${auth.token}` };

  const upload = await app.inject({
    method: "POST",
    url: "/materials",
    headers,
    payload: {
      name: "验证素材",
      mimeType: "image/png",
      dataUrl: DATA_URL,
      width: 32,
      height: 24,
    },
  });
  const material = upload.json();
  createdId = material?.id ?? "";
  check("上传素材返回 201 和记录", upload.statusCode === 201 && Boolean(createdId), `HTTP ${upload.statusCode}`);
  check("素材 URL 落到 /files/:id", typeof material?.url === "string" && material.url.includes("/files/"));
  check(
    "素材尺寸入库",
    material?.width === 32 && material?.height === 24,
    `${material?.width}x${material?.height}`,
  );

  const list = await app.inject({ method: "GET", url: "/materials", headers });
  const items = list.json();
  check(
    "刷新（重新 GET /materials）后仍能读到",
    list.statusCode === 200 &&
      Array.isArray(items) &&
      items.some((item) => item.id === createdId),
    `${Array.isArray(items) ? items.length : "?"} 条`,
  );

  const row = await getDb()
    .from("user_materials")
    .select("file_id")
    .eq("id", createdId)
    .maybeSingle();
  const fileId = row.data?.file_id ?? "";
  const stored = fileId
    ? await getDb().storage.from("project-files").download(`attachments/${fileId}`)
    : { data: null, error: new Error("缺少 file_id") };
  check(
    "文件本体已写入 Storage（不是只在进程内存）",
    Boolean(stored.data) && !stored.error,
    fileId ? "attachments/" + fileId.slice(0, 8) + "…" : "无 file_id",
  );

  const file = await app.inject({
    method: "GET",
    url: material?.url?.replace(/^https?:\/\/[^/]+/, "") ?? "/files/missing",
  });
  check(
    "文件本体可通过 /files/:id 读取",
    file.statusCode === 200 && file.headers["content-type"]?.includes("image/png"),
    `HTTP ${file.statusCode} ${file.headers["content-type"]}`,
  );

  const bad = await app.inject({
    method: "POST",
    url: "/materials",
    headers,
    payload: { name: "坏素材", dataUrl: "data:text/plain;base64,aGVsbG8=" },
  });
  check("非图片素材被拒绝", bad.statusCode === 400, `HTTP ${bad.statusCode}`);

  const removed = await app.inject({
    method: "POST",
    url: `/materials/${createdId}/delete`,
    headers,
  });
  createdId = "";
  check("删除素材成功", removed.statusCode === 200, `HTTP ${removed.statusCode}`);

  const after = await app.inject({ method: "GET", url: "/materials", headers });
  check(
    "删除后列表不再出现",
    after.statusCode === 200 && !after.json().some((item) => item.id === material?.id),
  );

  const fileAfter = await app.inject({
    method: "GET",
    url: material?.url?.replace(/^https?:\/\/[^/]+/, "") ?? "/files/missing",
  });
  check("删除后文件 404", fileAfter.statusCode === 404, `HTTP ${fileAfter.statusCode}`);

  const storedAfter = fileId
    ? await getDb().storage.from("project-files").download(`attachments/${fileId}`)
    : { data: null, error: new Error("缺少 file_id") };
  // Storage 删除是最终一致的：下载可能命中 CDN 缓存，用 list 判断对象是否真的还在
  let storageGone = false;
  for (let attempt = 0; attempt < 10 && !storageGone; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400));
    const listed = await getDb()
      .storage.from("project-files")
      .list("attachments", { search: fileId });
    storageGone = !listed.error && (listed.data ?? []).length === 0;
  }
  check(
    "删除后 Storage 对象已清理",
    storageGone,
    storageGone
      ? "list 里已不存在"
      : `仍存在（file_id=${fileId.slice(0, 8)}…，download=${storedAfter.error ? "404" : "200"}）`,
  );
} catch (error) {
  results.push({ name: "执行素材库验收", ok: false });
  console.error("FAIL 执行素材库验收 —", error instanceof Error ? error.message : error);
} finally {
  if (app && createdId) {
    try {
      await app.inject({
        method: "POST",
        url: `/materials/${createdId}/delete`,
        headers: { authorization: `Bearer ${(await tokenFor(email)).token}` },
      });
    } catch {
      // 清理失败不影响结论
    }
  }
  if (app) await app.close();
  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  console.log(`store=${env.projectsStore}`);
  // buildApp 会启动 job worker / checkpointer 预热，可能有常驻 handle；脚本跑完直接退出
  process.exit(failed === 0 ? 0 : 1);
}