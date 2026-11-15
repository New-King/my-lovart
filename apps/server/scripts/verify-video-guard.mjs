/**
 * 视频前期闸门验收：脚本/镜头未确认、首帧未确认时，generate_video 必须被拦下。
 * 不调用任何视频生成服务。
 * 用法：pnpm --filter @my-lovart/server verify:video-guard
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../dist/db/supabase.js";
import { getAssetsRepository } from "../dist/features/assets/assets.repository.js";
import { getStoryboardsRepository } from "../dist/features/storyboards/storyboards.repository.js";
import {
  checkVideoPreflight,
  createAgentTools,
} from "../dist/features/agent/tools.js";

const projectId = randomUUID();
const userId = randomUUID();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function baseContext(runStartedAt) {
  return {
    bus: { push() {} },
    projectId,
    runStartedAt,
    attachmentMap: {},
    canvasSummary: "",
    canvasElements: [],
    projectAssets: [],
    baseUrl: "http://127.0.0.1:3001",
    signal: new AbortController().signal,
  };
}

try {
  const created = await getDb()
    .from("projects")
    .insert({ id: projectId, user_id: userId, name: "__verify_video_guard__" });
  if (created.error) throw created.error;

  const repo = await getStoryboardsRepository();

  // 1) 没有 shotId：工具应直接返回计划缺失，不提交作业
  const tools = createAgentTools(baseContext(new Date().toISOString()));
  const videoTool = tools.find((item) => item.name === "generate_video");
  const noShot = JSON.parse(
    await videoTool.invoke({
      title: "5 秒自行车广告",
      prompt: "城市清晨，骑行者穿过街道，镜头跟随，暖色光线",
      aspectRatio: "16:9",
      durationSeconds: 5,
    }),
  );
  check(
    "无 shotId 时拒绝直接出片",
    noShot.code === "video_plan_required",
    noShot.code ?? "no code",
  );

  // 2) 本轮刚建的镜头：脚本还没给用户看
  const runStart = new Date(Date.now() - 1000).toISOString();
  const board = await repo.create(projectId, {
    title: "自行车广告",
    brief: "5 秒城市骑行广告",
    aspectRatio: "16:9",
    shots: [{ title: "骑行开场", description: "清晨街道，骑行出发", durationSeconds: 5 }],
  });
  const shot = board.shots[0];
  const freshPlan = await checkVideoPreflight(baseContext(runStart), shot.id, false);
  check(
    "本轮新建镜头时拒绝出片",
    freshPlan?.code === "video_plan_unconfirmed",
    freshPlan?.code ?? "allowed",
  );

  // 3) 镜头是上一轮的，但还没有首帧关键图
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const agedShot = await getDb()
    .from("storyboard_shots")
    .update({ created_at: hourAgo, active_asset_id: null })
    .eq("id", shot.id);
  if (agedShot.error) throw agedShot.error;

  const noKeyframe = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    shot.id,
    false,
  );
  check(
    "缺首帧关键图时拒绝出片",
    noKeyframe?.code === "keyframe_required",
    noKeyframe?.code ?? "allowed",
  );

  // 4) 有上一轮的关键图：允许进入出片（这里只验闸门，不生成视频）
  const assetId = randomUUID();
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await (await getAssetsRepository()).save(projectId, {
    id: assetId,
    projectId,
    kind: "image",
    origin: "generated",
    title: "骑行开场 首帧",
    prompt: "清晨城市街道，骑行者出发，暖色逆光，电影感",
    model: "Seedream 5.0 Lite",
    url: "http://127.0.0.1:3001/files/verify-video-guard-keyframe",
    mimeType: "image/png",
    width: 1280,
    height: 720,
    sourceAssetIds: [],
    metadata: {},
    createdAt: tenMinutesAgo,
  });
  const linked = await getDb()
    .from("storyboard_shots")
    .update({ active_asset_id: assetId })
    .eq("id", shot.id);
  if (linked.error) throw linked.error;

  const allowed = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    shot.id,
    false,
  );
  check("已确认脚本 + 首帧时放行", allowed === null, allowed?.code ?? "allowed");

  // 5) 关键图是本轮刚出的：仍要让用户先看到画面
  const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const freshKeyframe = await checkVideoPreflight(
    baseContext(twentyMinutesAgo),
    shot.id,
    false,
  );
  check(
    "本轮新出的首帧仍要求确认",
    freshKeyframe?.code === "keyframe_unconfirmed",
    freshKeyframe?.code ?? "allowed",
  );

  // 6) 用户明确要求跳过时才放行
  const direct = await checkVideoPreflight(baseContext(new Date().toISOString()), undefined, true);
  check("direct=true 显式跳过前期", direct === null, direct?.code ?? "allowed");
} catch (error) {
  results.push({ name: "执行验收脚本", ok: false });
  console.error("FAIL 执行验收脚本 —", error instanceof Error ? error.message : error);
} finally {
  const removed = await getDb().from("projects").delete().eq("id", projectId);
  if (removed.error) console.error("清理项目失败：", removed.error.message);
  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exitCode = failed === 0 ? 0 : 1;
}