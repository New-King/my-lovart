/**
 * Phase 1 持久化验收脚本。
 * 用法：pnpm --filter @my-lovart/server verify:persistence
 * 会创建临时 project，验证消息/画布/Storage，然后 cascade 删除。
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../dist/db/supabase.js";
import { createWorkspaceService } from "../dist/features/workspace/workspace.service.js";
import { STORAGE_BUCKET } from "../dist/features/files/storage.js";

const db = getDb();
const projectId = randomUUID();
const userId = randomUUID();
const fileId = `verify-${randomUUID()}`;
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  const inserted = await db
    .from("projects")
    .insert({ id: projectId, user_id: userId, name: "__verify_persistence__" });
  if (inserted.error) throw inserted.error;

  const service = createWorkspaceService();
  await service.saveCanvas(
    projectId,
    [{ id: "verify-el", type: "image", x: 1, y: 2, width: 3, height: 4 }],
    {
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL: png,
        created: Date.now(),
        lastRetrieved: Date.now(),
      },
    },
  );
  const userMessage = await service.appendUserMessage(projectId, "__verify_message__", []);

  // 新 service 实例 = 新进程视角，不共享内存缓存
  const fresh = createWorkspaceService();
  const workspace = await fresh.get(projectId);

  check(
    "消息可读回",
    workspace.messages.some((message) => message.id === userMessage.id),
    `${workspace.messages.length} 条`,
  );
  check("画布元素可读回", workspace.elements.length === 1);
  check(
    "画布文件可下载并转回 dataURL",
    workspace.files[fileId]?.dataURL?.startsWith("data:image/png"),
  );

  const canvasRow = await db
    .from("canvases")
    .select("files")
    .eq("project_id", projectId)
    .maybeSingle();
  const manifest = canvasRow.data?.files?.[fileId];
  check(
    "数据库只存 Storage manifest",
    Boolean(manifest?.path) && !manifest?.dataURL,
    manifest?.path ?? "no path",
  );
} catch (err) {
  console.error("ERROR", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.storage.from(STORAGE_BUCKET).remove([`${projectId}/${fileId}`]);
  await db.from("projects").delete().eq("id", projectId);
  console.log("已清理临时 project 与 Storage 文件");
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`${failed.length} 项失败`);
  process.exitCode = 1;
} else {
  console.log("Phase 1 持久化验证通过");
}