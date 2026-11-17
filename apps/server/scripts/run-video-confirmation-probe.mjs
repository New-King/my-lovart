/**
 * 真实模型行为探针：用户答完 3 个问题后，Agent 不能只给文字分镜就停。
 *
 * 复刻现场：
 * 1. “我要做一个 10 秒的单车广告” → Agent 出提问卡；
 * 2. 用户按卡片回答公路车 / 16:9 / 硬核速度感；
 * 3. 期望同轮 create_storyboard + generate_image(role=canon)；不能以“确认后我就生成设定图”收尾。
 *
 * 图片渠道 key 置空：只验证有没有发起 canon 生成，不消耗额度。
 * 用法：pnpm --filter @my-lovart/server run:video-confirmation-probe
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

process.env.PROJECTS_STORE = "memory";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.SUPABASE_DB_URL = "";
process.env.GENERATION_MODE = "real";
process.env.ARK_API_KEY = "";
process.env.VOLCES_API_KEY = "";
process.env.METASO_API_KEY = "";
process.env.PEXELS_API_KEY = "";

const { createWorkspaceService } = await import(
  "../dist/features/workspace/workspace.service.js"
);

const projectId = randomUUID();
const service = createWorkspaceService(Promise.resolve(null));
const baseUrl = "http://127.0.0.1:3001";

async function runTurn(text) {
  const userMessage = await service.appendUserMessage(projectId, text, []);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
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
        console.log(`tool: ${event.tool.tool} · ${event.tool.title}`);
      }
      if (event.type === "tool.failed") {
        console.log(`tool failed: ${event.error.code}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const snapshot = await service.get(projectId);
  const assistant = [...snapshot.messages].reverse().find((m) => m.role === "assistant");
  return { tools, assistant };
}

const first = await runTurn("我要做一个 10 秒的单车广告");
console.log("turn1 tools:", first.tools.join(","));
console.log("turn1 questions:", first.assistant?.questions?.length ?? 0);

const answer = `我的回答：
1. 这条片子拍的是哪类单车？：公路车（速度、竞赛感）
2. 投放在哪里，用什么画幅？：横屏 16:9（官网/大屏/B站）
3. 画面基调想往哪个方向走？：硬核速度感：低机位、逆光、飞驰`;

const second = await runTurn(answer);
const finalText = second.assistant?.content ?? "";

const assertions = [
  {
    name: "答完问题后建了分镜",
    pass: second.tools.includes("create_storyboard"),
    detail: second.tools.join(" → ") || "无工具",
  },
  {
    name: "建完分镜同轮发起 canon 生成（不只停在文字稿）",
    pass:
      second.tools.includes("generate_image") ||
      second.tools.includes("register_reference"),
    detail: second.tools.join(" → "),
  },
  {
    name: "没有用“确认后我就……”空承诺收尾",
    pass: !/确认这版分镜后，?我就|确认后我就|确认后再.{0,6}(生成|出图)/.test(finalText),
    detail: finalText.slice(-120),
  },
  {
    name: "结尾是明确问题或说明失败，不是悬空陈述",
    pass:
      /[？?]/.test(finalText.slice(-220)) ||
      /失败|无法|缺少|不可用/.test(finalText.slice(-120)),
    detail: finalText.slice(-80),
  },
];

const outDir = resolve(
  process.cwd(),
  "../../verification/video-confirmation-probe-2026-11-17",
);
await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(outDir, "transcript.json"),
  JSON.stringify({ first, second, finalText, assertions }, null, 2),
);

for (const item of assertions) {
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
const failed = assertions.filter((item) => !item.pass).length;
console.log(`\n${assertions.length - failed}/${assertions.length} 通过`);
console.log(`JSON: ${resolve(outDir, "transcript.json")}`);
process.exit(failed === 0 ? 0 : 1);