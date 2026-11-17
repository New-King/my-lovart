/**
 * 真实模型行为探针：用户给一张角色图 + “生成 5 秒视频让她站起来靠近”。
 *
 * 不生成任何图片/视频（ARK/METASO key 置空），只看 Agent 会不会：
 * - 直接把用户图当 image-to-video 源，调用 generate_video(inputImages, direct=true)；
 * - 不再画蛇添足生成“角色设定图”、首帧、尾帧。
 *
 * 用法：pnpm --filter @my-lovart/server run:image-to-video-probe
 */
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

process.env.PROJECTS_STORE = "memory";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.SUPABASE_DB_URL = "";
process.env.GENERATION_MODE = "real";
process.env.ARK_API_KEY = "";
process.env.METASO_API_KEY = "";
process.env.PEXELS_API_KEY = "";

const { createWorkspaceService } = await import(
  "../dist/features/workspace/workspace.service.js"
);
const { normalizeAttachment } = await import("../dist/features/files/file.store.js");

const baseUrl = "http://127.0.0.1:3001";
const projectId = randomUUID();
const service = createWorkspaceService(Promise.resolve(null));
const image = await readFile(resolve(process.cwd(), "scripts/fixtures/character.png"));
const dataUrl = `data:image/png;base64,${image.toString("base64")}`;
const attachment = await normalizeAttachment(
  { name: "角色参考图.png", mimeType: "image/png", url: dataUrl, width: 512, height: 768 },
  baseUrl,
);
if (!attachment) throw new Error("附件归一化失败");

const text = "生成 5 秒的视频，让这个人物站起来向我靠近";
const userMessage = await service.appendUserMessage(projectId, text, [attachment]);

const events = [];
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240_000);
try {
  for await (const event of service.run(
    projectId,
    {
      text,
      kind: "auto",
      attachments: [attachment],
      userMessageId: userMessage.id,
      baseUrl,
      rawAttachmentCount: 1,
    },
    controller.signal,
  )) {
    events.push(event);
    if (event.type === "tool.started") {
      console.log(`tool: ${event.tool.tool} · ${event.tool.title}`);
    }
    if (event.type === "tool.failed") {
      console.log(`tool failed: ${event.error.code} ${event.error.message}`);
    }
    if (event.type === "artifact.ready") {
      console.log(`artifact: ${event.artifact.type}`);
    }
  }
} finally {
  clearTimeout(timer);
}

const snapshot = await service.get(projectId);
const tools = events
  .filter((event) => event.type === "tool.started")
  .map((event) => ({
    name: event.tool.tool,
    title: event.tool.title,
    inputSummary: event.tool.inputSummary,
    detail: event.tool.detail,
  }));
const assistant = snapshot.messages.find((message) => message.role === "assistant");

const assertions = [
  {
    name: "没有调用 generate_image 生成角色/首尾帧",
    pass: !tools.some((tool) => tool.name === "generate_image"),
  },
  {
    name: "调用了 generate_video 直接做 image-to-video",
    pass: tools.some((tool) => tool.name === "generate_video"),
    detail: tools.map((tool) => tool.name).join(" → "),
  },
  {
    name: "没有多镜头 register_reference / 分镜流程",
    pass: !tools.some(
      (tool) => tool.name === "register_reference" || tool.name === "create_storyboard",
    ),
  },
  {
    name: "回复没有把“角色/产品设定图”当成默认流程",
    pass: !/角色设定图|产品设定图|生成.{0,8}设定图/.test(assistant?.content ?? ""),
    detail: (assistant?.content ?? "").slice(0, 120),
  },
  {
    name: "本轮没有真的产出图片/视频",
    pass: !snapshot.messages.some((message) =>
      (message.blocks ?? []).some((block) => block.type === "image" || block.type === "video"),
    ),
  },
];

const outDir = resolve(process.cwd(), "../../verification/image-to-video-probe-2026-11-17");
await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(outDir, "transcript.json"),
  JSON.stringify({ text, tools, assistant: assistant?.content ?? "", assertions }, null, 2),
);

for (const item of assertions) {
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
const failed = assertions.filter((item) => !item.pass).length;
console.log(`\n${assertions.length - failed}/${assertions.length} 通过`);
console.log(`JSON: ${resolve(outDir, "transcript.json")}`);
process.exit(failed === 0 ? 0 : 1);