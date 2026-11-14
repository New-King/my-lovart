/**
 * Phase 1c 产物账本验收。
 * 用法：pnpm --filter @my-lovart/server verify:assets
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../dist/db/supabase.js";
import { getAssetsRepository } from "../dist/features/assets/assets.repository.js";
import { buildProjectAssetsContext } from "../dist/features/agent/context.js";
import { collectLegacyAssets, mergeAssets } from "../dist/features/assets/assets.js";

const projectId = randomUUID();
const userId = randomUUID();
const imageId = randomUUID();
const videoId = randomUUID();
const createdAt = new Date().toISOString();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  const inserted = await getDb()
    .from("projects")
    .insert({ id: projectId, user_id: userId, name: "__verify_assets__" });
  if (inserted.error) throw inserted.error;

  const repo = await getAssetsRepository();
  await repo.save(projectId, {
    id: imageId,
    projectId,
    kind: "image",
    origin: "generated",
    title: "秋季咖啡海报 v1",
    prompt: "暖秋咖啡海报，窗边逆光，琥珀色渐变，极简排版",
    model: "Seedream 5.0 Lite",
    url: "http://127.0.0.1:3001/files/verify-image",
    mimeType: "image/png",
    width: 1024,
    height: 1536,
    aspectRatio: "3:4",
    sourceAssetIds: ["asset-ref-1"],
    messageId: randomUUID(),
    metadata: {},
    createdAt,
  });
  await repo.save(projectId, {
    id: videoId,
    projectId,
    kind: "video",
    origin: "generated",
    title: "咖啡杯 5 秒动效",
    prompt: "镜头缓慢推近，热气上升，暖色光线",
    model: "MiniMax H3",
    url: "http://127.0.0.1:3001/files/verify-video",
    mimeType: "video/mp4",
    width: 1280,
    height: 720,
    durationSeconds: 5,
    sourceAssetIds: [],
    messageId: randomUUID(),
    metadata: {},
    createdAt,
  });

  const list = await repo.list(projectId);
  check("资产可读回", list.length === 2, `${list.length} 条`);
  const image = list.find((item) => item.id === imageId);
  check("title 保留", image?.title === "秋季咖啡海报 v1");
  check("完整 prompt 保留", image?.prompt.includes("琥珀色渐变"));
  check("来源血缘保留", image?.sourceAssetIds?.[0] === "asset-ref-1");
  check("视频时长保留", list.find((item) => item.id === videoId)?.durationSeconds === 5);

  const single = await repo.get(projectId, imageId);
  check("get_asset 可精确取到", single?.id === imageId);

  const context = buildProjectAssetsContext(list);
  check("注入 <project_assets>", context.xml.includes('<asset id="' + imageId + '"'));
  check("上下文包含标题", context.xml.includes("秋季咖啡海报 v1"));
  check("上下文包含尺寸", context.xml.includes('size="1024x1536"'));
  check("上下文最多 12 条", context.injected.length <= 12);

  const legacy = collectLegacyAssets([
    {
      id: "m1",
      role: "assistant",
      content: "",
      createdAt,
      blocks: [
        {
          type: "image",
          id: "legacy-1",
          url: "http://127.0.0.1:3001/files/legacy",
          mimeType: "image/png",
          width: 400,
          height: 500,
          title: "旧消息里的图",
          prompt: "旧 prompt",
          sourceAssetIds: [],
        },
      ],
    },
  ]);
  check("旧消息可还原成资产", legacy.length === 1 && legacy[0]?.title === "旧消息里的图");

  const merged = mergeAssets(list, legacy);
  check("账本与旧消息合并去重", merged.length === 3);
} catch (err) {
  console.error("ERROR", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await getDb().from("projects").delete().eq("id", projectId);
  console.log("已清理临时 project");
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`${failed.length} 项失败`);
  process.exitCode = 1;
} else {
  console.log("Phase 1c 产物账本验证通过");
}