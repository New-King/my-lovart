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
  checkDirectVideoInput,
  checkVideoPreflight,
  createAgentTools,
  planImageReferences,
  userAllowsDirectVideo,
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

  const strictBoard = await repo.create(projectId, {
    title: "严格一致性分镜",
    brief: "客户要求产品必须还原真实实拍",
    kind: "image",
    metadata: { consistency: "strict" },
    shots: [{ title: "S1" }],
  });
  const adaptiveBoard = await repo.create(projectId, {
    title: "自适应分镜",
    brief: "没有实拍时允许先出设定图",
    kind: "image",
    metadata: { consistency: "adaptive" },
    shots: [{ title: "S1" }],
  });

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

  const noPhoto = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "canon",
    anchorType: "product",
    storyboardId: strictBoard.storyboard.id,
  });
  check(
    "strict 策略没有产品实拍时拒绝纯文生图锚图",
    noPhoto.error?.code === "canon_photo_required",
    noPhoto.error?.code ?? "allowed",
  );

  const noDetailPhoto = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "canon",
    anchorType: "product_detail",
    storyboardId: strictBoard.storyboard.id,
  });
  check(
    "strict 策略没有细节实拍时拒绝纯文生图细节锚图",
    noDetailPhoto.error?.code === "detail_photo_required",
    noDetailPhoto.error?.code ?? "allowed",
  );

  // 用户已经给了角色图：应该直接登记为 canon，而不是再生成一版“角色设定图”
  const referenceContext = {
    ...baseContext(new Date().toISOString()),
    userText: "生成 5 秒的视频，让这个人物站起来向我靠近",
    attachments: [
      {
        id: "user-char",
        name: "角色参考图",
        mimeType: "image/png",
        url: "/files/user-char",
        size: 1024,
      },
    ],
    attachmentMap: { "asset-user-char": "data:image/png;base64,AAAA" },
  };
  const referenceBoard = await repo.create(projectId, {
    title: "用户参考图分镜",
    brief: "用户已经提供了角色图，直接作为身份基准",
    kind: "video",
    aspectRatio: "16:9",
    totalDurationSeconds: 10,
    metadata: { consistency: "adaptive" },
    shots: [
      { title: "S1", durationSeconds: 5 },
      { title: "S2", durationSeconds: 5 },
    ],
  });
  const referenceTools = createAgentTools(referenceContext);
  const registerTool = referenceTools.find((item) => item.name === "register_reference");
  const registered = JSON.parse(
    await registerTool.invoke({
      title: "用户角色图",
      assetId: "asset-user-char",
      storyboardId: referenceBoard.storyboard.id,
      anchorType: "character",
    }),
  );
  const boardAfterRegister = await repo.get(projectId, referenceBoard.storyboard.id);
  check(
    "用户提供的角色图可直接登记为 canon（不重新生成）",
    Boolean(registered.asset_id) &&
      boardAfterRegister?.storyboard.characterAnchorAssetId === registered.asset_id &&
      boardAfterRegister?.storyboard.canonAssetId === registered.asset_id,
    registered.error ?? registered.asset_id ?? "no asset",
  );

  await repo.updateStoryboard(projectId, referenceBoard.storyboard.id, {
    metadata: { referenceDirect: true },
  });
  const referenceDirectPreflight = await checkVideoPreflight(
    baseContext(new Date(Date.now() + 5000).toISOString()),
    referenceBoard.shots[0].id,
    false,
  );
  check(
    "referenceDirect：有用户 canon 时不需要先生成关键帧",
    referenceDirectPreflight === null,
    referenceDirectPreflight?.code ?? "allowed",
  );

  const framedPlan = await planImageReferences(
    baseContext(new Date(Date.now() + 5000).toISOString()),
    { role: "keyframe", shotId: referenceBoard.shots[0].id },
  );
  check(
    "关键帧继承分镜画幅（16:9 不会生成 9:16）",
    !framedPlan.error && framedPlan.aspectRatio === "16:9",
    framedPlan.error?.code ?? framedPlan.aspectRatio ?? "missing",
  );

  // image-to-video 的 direct 许可：有主体图才允许，否则要用户原话显式授权
  const directWithSource = checkDirectVideoInput({
    direct: true,
    inputImages: ["asset-user-char"],
    attachmentMap: { "asset-user-char": "data:image/png;base64,AAAA" },
    projectAssets: [],
    userText: "生成 5 秒的视频，让这个人物站起来向我靠近",
  });
  const directWithoutSource = checkDirectVideoInput({
    direct: true,
    inputImages: [],
    attachmentMap: {},
    projectAssets: [],
    userText: "生成 5 秒的视频，让这个人物站起来向我靠近",
  });
  const directExplicit = checkDirectVideoInput({
    direct: true,
    inputImages: [],
    attachmentMap: {},
    projectAssets: [],
    userText: "直接出片，不用确认",
  });
  check(
    "有主体图时单条 image-to-video 允许 direct",
    directWithSource.allowed && directWithSource.source,
  );
  check(
    "没有主体图、用户也没说直接出片时拒绝 direct",
    !directWithoutSource.allowed,
  );
  check(
    "用户原话明确“直接出片”时允许 direct",
    directExplicit.allowed && userAllowsDirectVideo("直接出片，不用确认"),
  );

  const adaptiveCanon = await planImageReferences(
    baseContext(new Date().toISOString()),
    {
      role: "canon",
      anchorType: "product",
      storyboardId: adaptiveBoard.storyboard.id,
    },
  );
  check(
    "adaptive 策略没有实拍时允许先生成产品设定图并给出警告",
    !adaptiveCanon.error &&
      adaptiveCanon.policy === "adaptive" &&
      /没有产品实拍/.test(adaptiveCanon.warning ?? ""),
    adaptiveCanon.error?.code ?? adaptiveCanon.warning ?? "allowed",
  );
  const adaptiveDetail = await planImageReferences(
    baseContext(new Date().toISOString()),
    {
      role: "canon",
      anchorType: "product_detail",
      storyboardId: adaptiveBoard.storyboard.id,
    },
  );
  check(
    "adaptive 策略没有细节实拍时允许生成细节锚图草案",
    !adaptiveDetail.error && adaptiveDetail.policy === "adaptive",
    adaptiveDetail.error?.code ?? "allowed",
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

  const openState = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "keyframe",
    shotId: shot.id,
    prompt: "低机位仰拍，开盖，螺纹口和杯内壁清晰可见",
  });
  check(
    "开盖/内部状态缺细节锚图时拒绝关键帧",
    openState.error?.code === "product_state_reference_required",
    openState.error?.code ?? "allowed",
  );

  const negativeState = await planImageReferences(
    baseContext(new Date().toISOString()),
    {
      role: "keyframe",
      shotId: shot.id,
      prompt: "晨光静置，杯盖全程闭合密封，不要出现开盖、螺纹、内胆、倒水、热气",
    },
  );
  check(
    "否定句里的“开盖/螺纹/内胆”不会被误判成状态要求",
    !negativeState.error,
    negativeState.error?.code ?? "allowed",
  );

  const actionNoActor = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "keyframe",
    shotId: shot.id,
    prompt: "公路竞速车从画面前方远处高速压弯逼近镜头，车身内倾",
  });
  check(
    "压弯动作没有骑手/人物时拒绝关键帧",
    actionNoActor.error?.code === "action_actor_required",
    actionNoActor.error?.code ?? "allowed",
  );

  const actionWithActor = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "keyframe",
    shotId: shot.id,
    prompt: "骑手压低身体，公路竞速车在弯道压弯逼近镜头",
  });
  check(
    "写清骑手和压弯姿态后放行关键帧",
    !actionWithActor.error,
    actionWithActor.error?.code ?? "allowed",
  );

  const detailId = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: detailId,
    projectId,
    kind: "image",
    origin: "generated",
    title: "保温杯 开盖细节锚图",
    prompt: "开盖后的螺纹口和内壁细节",
    url: "http://127.0.0.1:3001/files/verify-detail-anchor",
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    sourceAssetIds: [],
    metadata: { role: "canon", anchorType: "product_detail" },
    createdAt: hourAgo,
  });
  await repo.setAnchorAsset(projectId, board.storyboard.id, "product_detail", detailId);
  const withDetail = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "keyframe",
    shotId: shot.id,
    prompt: "低机位仰拍，开盖，螺纹口和杯内壁清晰可见",
  });
  check(
    "有细节锚图后开盖关键帧放行",
    !withDetail.error &&
      withDetail.references.includes("http://127.0.0.1:3001/files/verify-detail-anchor") &&
      withDetail.sourceAssetIds.includes(detailId),
    withDetail.error?.code ?? `refs=${withDetail.references.length}`,
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

  const currentPlan = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "keyframe",
    shotId: shot.id,
  });
  check(
    "重做同一镜首帧时以当前首帧为主参考",
    currentPlan.references[0] === "http://127.0.0.1:3001/files/verify-keyframe" &&
      currentPlan.sourceAssetIds.includes(assetId),
    `refs=${currentPlan.references.length}`,
  );

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

  const freshCanonId = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: freshCanonId,
    projectId,
    kind: "image",
    origin: "generated",
    title: "本轮刚生成的产品锚图",
    prompt: "还没有给用户确认",
    url: "http://127.0.0.1:3001/files/verify-fresh-canon",
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    sourceAssetIds: [],
    metadata: { role: "canon", anchorType: "product" },
    createdAt: new Date().toISOString(),
  });
  await repo.setAnchorAsset(projectId, board2.storyboard.id, "product", freshCanonId);
  const freshCanon = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "keyframe",
    shotId: shot1.id,
  });
  check(
    "本轮新生成的锚图未确认时不开放关键帧",
    freshCanon.error?.code === "canon_unconfirmed",
    freshCanon.error?.code ?? "allowed",
  );
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

  const actionVideo = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    shot1.id,
    false,
    "公路竞速车从画面深处高速压弯向镜头逼近，车身内倾",
  );
  check(
    "视频要求压弯但首帧/分镜没有骑手时拒绝出片",
    actionVideo?.code === "action_actor_required",
    actionVideo?.code ?? "allowed",
  );

  const actionVideoDirect = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    shot1.id,
    true,
    "公路竞速车从画面深处高速压弯向镜头逼近，车身内倾",
  );
  check(
    "direct=true 也不能绕过动作主体检查",
    actionVideoDirect?.code === "action_actor_required",
    actionVideoDirect?.code ?? "allowed",
  );

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

  const beforeVideo = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "keyframe",
    shotId: shot2.id,
  });
  check(
    "上一镜没视频时允许批量生成下一镜首帧（用尾帧做预览衔接）",
    !beforeVideo.error,
    beforeVideo.error?.code ?? "allowed",
  );

  // 模拟视频1已生成并抽出实际末帧
  const video1 = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: video1,
    projectId,
    kind: "video",
    origin: "generated",
    title: "通勤开场 视频",
    prompt: "通勤开场",
    url: "http://127.0.0.1:3001/files/verify-shot1-video.mp4",
    mimeType: "video/mp4",
    width: 1280,
    height: 720,
    durationSeconds: 5,
    sourceAssetIds: [first1, end1],
    shotId: shot1.id,
    metadata: { role: "video" },
    createdAt: tenMinutesAgo,
  });
  await repo.applyVideo(projectId, shot1.id, video1);

  const last1 = randomUUID();
  await (await getAssetsRepository()).save(projectId, {
    id: last1,
    projectId,
    kind: "image",
    origin: "derived",
    title: "通勤开场 实际末帧",
    prompt: "视频最后一帧",
    url: "http://127.0.0.1:3001/files/verify-shot1-last",
    mimeType: "image/jpeg",
    width: 1280,
    height: 720,
    sourceAssetIds: [video1],
    shotId: shot1.id,
    metadata: { role: "video_last_frame" },
    createdAt: tenMinutesAgo,
  });
  await repo.applyVideoLastFrame(projectId, shot1.id, last1);

  const shot2Plan = await planImageReferences(baseContext(new Date().toISOString()), {
    role: "keyframe",
    shotId: shot2.id,
  });
  check(
    "下一镜首帧自动承接上一镜实际末帧",
    shot2Plan.references.includes("http://127.0.0.1:3001/files/verify-shot1-last") &&
      shot2Plan.sourceAssetIds.includes(last1),
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
    "预生成首帧不要求上一镜末帧血缘，出片时改用实际末帧",
    loose === null,
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
    sourceAssetIds: [canonId, styleId, last1],
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
  check("两镜末帧接通后放行", continuous === null, continuous?.code ?? "allowed");

  // 10) 用户明确要求跳过时才放行
  const direct = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    undefined,
    true,
  );
  check("direct=true 显式跳过前期", direct === null, direct?.code ?? "allowed");

  // 11) loose 策略：没有锚图/首帧也能出片，多镜头不强制末帧衔接
  const looseBoard = await repo.create(projectId, {
    title: "快速草稿 10 秒",
    brief: "用户只要先看两个镜头大概",
    kind: "video",
    totalDurationSeconds: 10,
    metadata: { consistency: "loose" },
    shots: [
      { title: "镜头 A", durationSeconds: 5 },
      { title: "镜头 B", durationSeconds: 5 },
    ],
  });
  await getDb()
    .from("storyboard_shots")
    .update({ created_at: hourAgo })
    .eq("storyboard_id", looseBoard.storyboard.id);
  const looseShot1 = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    looseBoard.shots[0].id,
    false,
  );
  check(
    "loose 策略允许无 canon/首帧直接生成草稿",
    looseShot1 === null,
    looseShot1?.code ?? "allowed",
  );
  const looseShot2 = await checkVideoPreflight(
    baseContext(new Date().toISOString()),
    looseBoard.shots[1].id,
    false,
  );
  check(
    "loose 策略不强制上一镜视频与末帧衔接",
    looseShot2 === null,
    looseShot2?.code ?? "allowed",
  );
  const looseKeyframe = await planImageReferences(
    baseContext(new Date().toISOString()),
    { role: "keyframe", shotId: looseBoard.shots[0].id },
  );
  check(
    "loose 关键帧仍要求先有 canon（可先生成设定图）",
    looseKeyframe.error?.code === "canon_required" &&
      looseKeyframe.policy === "loose",
    looseKeyframe.error?.code ?? "allowed",
  );
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