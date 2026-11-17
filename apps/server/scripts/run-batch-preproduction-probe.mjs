/**
 * 真实模型批量前期探针：锚图确认后，一次性生成所有镜头首尾帧，再统一给脚本方案。
 *
 * 假方舟出图（不消耗额度），但模型、故事板、资产、工具链是真的。
 * 三轮：
 * 1. 需求 → 3 个问题；
 * 2. 答完 → 建分镜 + 产品 canon（假图），停；
 * 3. “设定图可以”→ 一次批量生成多镜首尾帧，停，给完整方案；不调用视频。
 *
 * 用法：pnpm --filter @my-lovart/server run:batch-preproduction-probe
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

process.env.PROJECTS_STORE = "memory";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.SUPABASE_DB_URL = "";
process.env.GENERATION_MODE = "real";
process.env.ARK_API_KEY = "probe-ark-key";
process.env.VOLCES_API_KEY = "";
process.env.METASO_API_KEY = "";
process.env.PEXELS_API_KEY = "";

const realFetch = globalThis.fetch;
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const arkRequests = [];

globalThis.fetch = async (input, init = {}) => {
  const url = String(typeof input === "string" ? input : input?.url ?? input);
  if (url.includes("ark.cn-beijing.volces.com") && url.includes("/images/generations")) {
    arkRequests.push(JSON.parse(String(init.body ?? "{}")));
    return new Response(JSON.stringify({ data: [{ url: PNG_DATA_URL }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.startsWith("data:image/")) {
    const comma = url.indexOf(",");
    const meta = url.slice(0, comma);
    const payload = url.slice(comma + 1);
    const buffer = meta.includes(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return new Response(buffer, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }
  return realFetch(input, init);
};

const { createWorkspaceService } = await import(
  "../dist/features/workspace/workspace.service.js"
);
const { getStoryboardsRepository } = await import(
  "../dist/features/storyboards/storyboards.repository.js"
);
const { getAssetsRepository } = await import("../dist/features/assets/assets.repository.js");
const { activeShots } = await import("../dist/features/storyboards/storyboards.js");

const projectId = randomUUID();
const service = createWorkspaceService(Promise.resolve(null));
const baseUrl = "http://127.0.0.1:3001";

async function runTurn(text) {
  const userMessage = await service.appendUserMessage(projectId, text, []);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  const tools = [];
  try {
    for await (const event of service.run(
      projectId,
      {
        text,
        kind: "auto",
        attachments: [],
        userMessageId: userMessage.id,
        baseUrl,
        rawAttachmentCount: 0,
      },
      controller.signal,
    )) {
      if (event.type === "tool.started") {
        tools.push(event.tool.tool);
        console.log(`tool: ${event.tool.tool}`);
      }
      if (event.type === "tool.failed") console.log(`tool failed: ${event.error.code}`);
    }
  } finally {
    clearTimeout(timer);
  }
  const snapshot = await service.get(projectId);
  const assistant = [...snapshot.messages].reverse().find((m) => m.role === "assistant");
  return { tools, assistant };
}

const first = await runTurn("我要做一个 10 秒的公路车广告");
const answer = `我的回答：
1. 这条片子拍的是哪类单车？：公路车（速度、竞赛感）
2. 投放在哪里，用什么画幅？：横屏 16:9（官网/大屏/B站）
3. 画面基调想往哪个方向走？：硬核速度感：低机位、逆光、飞驰`;
const second = await runTurn(answer);
const third = await runTurn("产品设定图可以，按这个继续。");
const fourth = await runTurn("这个流程可以，按顺序开始出片。");

const repo = await getStoryboardsRepository();
const boards = await repo.list(projectId);
const detail = boards[0] ? await repo.get(projectId, boards[0].id) : null;
const shots = detail ? activeShots(detail) : [];
const assets = await (await getAssetsRepository()).list(projectId, 50);
const frameAssets = assets.filter((asset) => asset.metadata?.role === "keyframe" || asset.metadata?.role === "end_frame");

const assertions = [
  {
    name: "第二轮建分镜 + 生成 canon",
    pass: second.tools.includes("create_storyboard") && second.tools.includes("generate_image"),
    detail: second.tools.join(" → "),
  },
  {
    name: "第三轮批量生成多个镜头帧（不是只做一张）",
    pass: third.tools.filter((tool) => tool === "generate_image").length >= 2,
    detail: `${third.tools.filter((tool) => tool === "generate_image").length} 次 generate_image`,
  },
  {
    name: "所有镜头都有首帧；非收尾镜头有尾帧",
    pass:
      shots.length >= 2 &&
      shots.every((shot) => Boolean(shot.firstFrameAssetId)) &&
      shots.slice(0, -1).every((shot) => Boolean(shot.endFrameAssetId)),
    detail: shots
      .map((shot) => `${shot.title}:${shot.firstFrameAssetId ? "首" : "无"}/${shot.endFrameAssetId ? "尾" : "无"}`)
      .join(" · "),
  },
  {
    name: "第三轮没有越过方案确认直接出视频",
    pass: !third.tools.includes("generate_video"),
  },
  {
    name: "第三轮结尾给出完整方案并要求确认",
    pass: /[？?]/.test((third.assistant?.content ?? "").slice(-240)),
    detail: (third.assistant?.content ?? "").slice(-100),
  },
  {
    name: "用户确认后直接开始出视频，不再重复确认",
    pass: fourth.tools.includes("generate_video"),
    detail: fourth.tools.join(" → "),
  },
  {
    name: "确认出片后没有重新生成分镜图",
    pass: !fourth.tools.includes("generate_image"),
    detail: fourth.tools.join(" → "),
  },
];

const outDir = resolve(process.cwd(), "../../verification/batch-preproduction-probe-2026-11-17");
await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(outDir, "transcript.json"),
  JSON.stringify(
    { first, second, third, fourth, shots, assets: assets.map((a) => ({ id: a.id, role: a.metadata?.role, title: a.title })), arkRequests: arkRequests.length, assertions },
    null,
    2,
  ),
);

for (const item of assertions) {
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
const failed = assertions.filter((item) => !item.pass).length;
console.log(`\n${assertions.length - failed}/${assertions.length} 通过`);
console.log(`JSON: ${resolve(outDir, "transcript.json")}`);
process.exit(failed === 0 ? 0 : 1);