/**
 * 视频前期闸门验收：设定图 canon、镜头时长、关键帧引用链、出片前的确认。
 * 不调用任何图片/视频生成服务。
 * 用法：pnpm --filter @my-lovart/server verify:video-guard
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../dist/db/supabase.js";
import { getAssetsRepository } from "../dist/features/assets/assets.repository.js";
import { getStoryboardsRepository } from "../dist/features/storyboards/storyboards.repository.js";
import {
  checkVideoPreflight,
  createAgentTools,
  planImageReferences,
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

  // 2) 5 秒拆 4 个镜头应被拒绝（每段至少 4 秒）
  let tooMany = "";
  try {
    await repo.create(projectId, {
      title: "错误拆法",
      brief: "5 秒拆 4 段",
      kind: "video",
      totalDurationSeconds: 5,
      shots: [
        { title: "S1", durationSeconds: 1 },
        { title: "S2", durationSeconds: 1 },
        { title: "S3", durationSeconds: 1 },
        { title: "S4", durationSeconds: 2 },
      ],
    });
  } catch (err) {
    tooMany = err instanceof Error ? err.message : String(err);
  }
  check("5 秒不允许拆成 4 个镜头", /最多 1 个镜头|至少 4 秒/.test(tooMany), tooMany || "allowed");

  // 2b) 纯视觉分镜不能直接改成视频时间线：旧镜头时长不合法
  const visual = await repo.create(projectId, {
    title: "四格概念板",
    brief: "没有时长的视觉概念",
    kind: "image",
    shots: [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }],
  });
  let badConvert = "";
  try {
    await repo.updateStoryboard(projectId, visual.storyboard.id, {
      kind: "video",
      totalDurationSeconds: 10,
    });
  } catch (err) {
    badConvert = err instanceof Error ? err.message : String(err);
  }
  check(
    "概念板不能直接改成不合法时间线",
    /必须给 4-15 秒|最多|不一致/.test(badConvert),
    badConvert || "allowed",
  );

  // 3) 本轮刚建的镜头：脚本还没给用户看
  const runStart = new Date(Date.now() - 1000).toISOString();
  const board = await repo.create(projectId, {
    title: "保温杯 5 秒广告",
    brief: "5 秒城市通勤保温杯广告",
    kind: "video",
    totalDurationSeconds: 5,
    shots: [{ title: "通勤开场", description: "清晨街角，保温杯静置", durationSeconds: 5 }],
  });
  const shot = board.shots[0];
  const freshPlan = await checkVideoPreflight(baseContext(runStart), shot.id, false);
  check(
    "本轮新建镜头时拒绝出片",
    freshPlan?.code === "video_plan_unconfirmed",
    freshPlan?.code ?? "allowed",
  );

  // 4) 上一轮镜头，但没有 canon 设定图：不允许各自文生图
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const agedShot = await getDb()
    .from("storyboard_shots")
    .update({ created_at: hourAgo, active_asset_id: null })
    .eq("id", shot.id);
  if (agedShot.error) throw agedShot.error;

  const noCanonPlan = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "keyframe",
    shotId: shot.id,
  });
  check(
    "缺 canon 时拒绝生成关键帧",
    noCanonPlan.error?.code === "canon_required",
    noCanonPlan.error?.code ?? "allowed",
  );
  const noCanonVideo = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    shot.id,
    false,
  );
  check(
    "缺 canon 时拒绝出片",
    noCanonVideo?.code === "canon_required",
    noCanonVideo?.code ?? "allowed",
  );

  // 5) 有 canon、但没有首帧关键图
  const canonId = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: canonId,
    projectId,
    kind: "image",
    origin: "generated",
    title: "保温杯 产品设定图",
    prompt: "奶白色哑光圆柱保温杯，竹木盖，产品设定图",
    model: "Seedream 5.0 Lite",
    url: "http://127.0.0.1:3001/files/verify-canon",
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    sourceAssetIds: [],
    metadata: { role: "canon" },
    createdAt: hourAgo,
  });
  await repo.setCanonAsset(projectId, board.storyboard.id, canonId);

  const keyframePlan = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "keyframe",
    shotId: shot.id,
  });
  check(
    "关键帧自动以 canon 为第一参考图",
    keyframePlan.references[0] === "http://127.0.0.1:3001/files/verify-canon" &&
      keyframePlan.canonId === canonId,
    `refs=${keyframePlan.references.length}`,
  );

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

  // 6) 手工塞一张图当首帧：没有 canon 血缘，应拒绝
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const manualId = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: manualId,
    projectId,
    kind: "image",
    origin: "generated",
    title: "手工首帧",
    prompt: "没有引用 canon 的独立图片",
    url: "http://127.0.0.1:3001/files/verify-manual",
    mimeType: "image/png",
    width: 1280,
    height: 720,
    sourceAssetIds: [],
    shotId: shot.id,
    metadata: {},
    createdAt: tenMinutesAgo,
  });
  await repo.applyFirstFrame(projectId, shot.id, manualId);
  const unanchored = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    shot.id,
    false,
  );
  check(
    "没有 canon 血缘的首帧被拒绝",
    unanchored?.code === "keyframe_not_anchored",
    unanchored?.code ?? "allowed",
  );

  // 7) 有上一轮的关键图：允许进入出片（这里只验闸门，不生成视频）
  const assetId = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: assetId,
    projectId,
    kind: "image",
    origin: "generated",
    title: "通勤开场 首帧",
    prompt: "清晨街角，奶白色保温杯，竹木盖，基于产品设定图",
    model: "Seedream 5.0 Lite",
    url: "http://127.0.0.1:3001/files/verify-keyframe",
    mimeType: "image/png",
    width: 1280,
    height: 720,
    sourceAssetIds: [canonId],
    shotId: shot.id,
    metadata: { role: "keyframe" },
    createdAt: tenMinutesAgo,
  });
  await repo.applyFirstFrame(projectId, shot.id, assetId);

  const allowed = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    shot.id,
    false,
  );
  check("已确认 canon + 首帧时放行", allowed === null, allowed?.code ?? "allowed");

  // 8) 首帧是本轮刚出的：仍要让用户先看到画面
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

  // 9) 多镜头：首镜缺尾帧拒绝；下一镜必须承接上一镜尾帧
  const board2 = await repo.create(projectId, {
    title: "保温杯 10 秒广告",
    brief: "两镜：通勤开场 + 冰水对比收尾",
    kind: "video",
    totalDurationSeconds: 10,
    shots: [
      {
        title: "通勤开场",
        sceneGoal: "开场建立",
        continuityNote: "结尾停在杯盖特写，交给下一镜",
        durationSeconds: 5,
      },
      {
        title: "冰水对比",
        sceneGoal: "卖点强调",
        continuityNote: "承接杯盖特写",
        durationSeconds: 5,
      },
    ],
  });
  const [shot1, shot2] = board2.shots;
  await getDb()
    .from("storyboard_shots")
    .update({ created_at: hourAgo })
    .eq("storyboard_id", board2.storyboard.id);

  const styleId = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: styleId,
    projectId,
    kind: "image",
    origin: "generated",
    title: "冷白日系主视觉锚图",
    prompt: "冷白 + 浅木色，柔和侧逆光，极简留白",
    url: "http://127.0.0.1:3001/files/verify-style-anchor",
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    sourceAssetIds: [],
    metadata: { role: "canon", anchorType: "style" },
    createdAt: hourAgo,
  });
  await repo.setAnchorAsset(projectId, board2.storyboard.id, "style", styleId);
  await repo.setAnchorAsset(projectId, board2.storyboard.id, "product", canonId);

  const first1 = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: first1,
    projectId,
    kind: "image",
    origin: "generated",
    title: "通勤开场 首帧",
    prompt: "清晨街角，保温杯",
    url: "http://127.0.0.1:3001/files/verify-shot1-first",
    mimeType: "image/png",
    width: 1280,
    height: 720,
    sourceAssetIds: [canonId, styleId],
    shotId: shot1.id,
    metadata: { role: "keyframe" },
    createdAt: tenMinutesAgo,
  });
  await repo.applyFirstFrame(projectId, shot1.id, first1);

  const missingEnd = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    shot1.id,
    false,
  );
  check(
    "多镜头首镜缺尾帧时拒绝出片",
    missingEnd?.code === "end_frame_required",
    missingEnd?.code ?? "allowed",
  );

  const end1 = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: end1,
    projectId,
    kind: "image",
    origin: "generated",
    title: "通勤开场 尾帧",
    prompt: "杯盖特写，保留交接状态",
    url: "http://127.0.0.1:3001/files/verify-shot1-end",
    mimeType: "image/png",
    width: 1280,
    height: 720,
    sourceAssetIds: [canonId, styleId, first1],
    shotId: shot1.id,
    metadata: { role: "end_frame" },
    createdAt: tenMinutesAgo,
  });
  await repo.applyEndFrame(projectId, shot1.id, end1);

  const shot2Plan = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "keyframe",
    shotId: shot2.id,
  });
  check(
    "下一镜首帧自动承接上一镜尾帧",
    shot2Plan.references.includes("http://127.0.0.1:3001/files/verify-shot1-end") &&
      shot2Plan.sourceAssetIds.includes(end1),
    `refs=${shot2Plan.references.length}`,
  );
  check(
    "生成 prompt 带上镜头职责和衔接",
    Boolean(
      shot2Plan.shotDirection?.includes("卖点强调") &&
        shot2Plan.shotDirection?.includes("承接杯盖特写"),
    ),
    shot2Plan.shotDirection ?? "empty",
  );

  const looseStart = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: looseStart,
    projectId,
    kind: "image",
    origin: "generated",
    title: "冰水对比 首帧（没接上）",
    prompt: "没有承接上一镜",
    url: "http://127.0.0.1:3001/files/verify-shot2-loose",
    mimeType: "image/png",
    width: 1280,
    height: 720,
    sourceAssetIds: [canonId, styleId],
    shotId: shot2.id,
    metadata: { role: "keyframe" },
    createdAt: tenMinutesAgo,
  });
  await repo.applyFirstFrame(projectId, shot2.id, looseStart);
  const loose = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    shot2.id,
    false,
  );
  check(
    "没承接上一镜尾帧的首帧被拒绝",
    loose?.code === "continuity_not_anchored",
    loose?.code ?? "allowed",
  );

  const first2 = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: first2,
    projectId,
    kind: "image",
    origin: "generated",
    title: "冰水对比 首帧",
    prompt: "承接杯盖特写，切到冰水",
    url: "http://127.0.0.1:3001/files/verify-shot2-first",
    mimeType: "image/png",
    width: 1280,
    height: 720,
    sourceAssetIds: [canonId, styleId, end1],
    shotId: shot2.id,
    metadata: { role: "keyframe" },
    createdAt: tenMinutesAgo,
  });
  await repo.applyFirstFrame(projectId, shot2.id, first2);
  const continuous = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    shot2.id,
    false,
  );
  check("两镜首尾帧接通后放行", continuous === null, continuous?.code ?? "allowed");

  // 10) 用户明确要求跳过时才放行
  const direct = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    undefined,
    true,
  );
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