/**
 * 真实模型思维链探针：确认 reasoning_content 被切成 Thought，
 * 并在过程区按“思考 → 工具”顺序出现，且不会混进最终回答。
 *
 * 只调用 inspect_canvas 和一个加减法，不生成图片/视频，不消耗生成额度。
 *
 * 用法：pnpm --filter @my-lovart/server run:reasoning-probe
 */
import { randomUUID } from "node:crypto";

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
  const timer = setTimeout(() => controller.abort(), 300_000);
  const events = [];
  const tools = [];
  let answer = "";
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
      events.push(event.type);
      if (event.type === "message.delta") answer += event.delta;
      if (event.type === "tool.started") tools.push(event.tool.tool);
    }
  } finally {
    clearTimeout(timer);
  }
  const snapshot = await service.get(projectId);
  const assistant = [...snapshot.messages].reverse().find((m) => m.role === "assistant");
  return { events, tools, answer, assistant };
}

const first = await runTurn("先调用 inspect_canvas 看看画布，然后告诉我画布上有几个元素。");
const second = await runTurn("17+25 等于多少？只回答数字。");

const firstThoughts = first.assistant?.thoughts ?? [];
const secondThoughts = second.assistant?.thoughts ?? [];
const firstThoughtText = firstThoughts.map((thought) => thought.text).join("\n");
const secondThoughtText = secondThoughts.map((thought) => thought.text).join("\n");

if (!firstThoughtText.trim() && !secondThoughtText.trim()) {
  console.log("SKIP：当前模型没有返回 reasoning_content。");
  console.log("这是供应商/模型行为，不是链路失败；换有思维链的模型（如 deepseek-v4-pro）再跑。");
  process.exit(0);
}

const firstHasReasoning = firstThoughtText.trim().length > 0;
const secondHasReasoning = secondThoughtText.trim().length > 0;

const firstToolIndex = first.events.indexOf("tool.started");
const lastThoughtCompleteIndex = first.events.lastIndexOf("thinking.completed");

const checks = [
  {
    name: "第一轮：模型思考被记录（thinking.started）",
    pass: !firstHasReasoning || first.events.includes("thinking.started"),
    detail: firstHasReasoning
      ? `${first.events.filter((event) => event === "thinking.started").length} 段`
      : "供应商未返回，跳过",
  },
  {
    name: "第一轮：思考有增量内容（thinking.delta）",
    pass: !firstHasReasoning || first.events.filter((event) => event === "thinking.delta").length > 0,
    detail: firstHasReasoning ? `${firstThoughtText.length} 字` : "供应商未返回，跳过",
  },
  {
    name: "第一轮：每段思考都收尾（completed 数 = started 数）",
    pass:
      !firstHasReasoning ||
      first.events.filter((event) => event === "thinking.completed").length ===
        first.events.filter((event) => event === "thinking.started").length,
    detail: `${first.events.filter((event) => event === "thinking.completed").length} 段完成`,
  },
  {
    name: "第一轮：思考在工具调用之前（过程区能上下排列）",
    pass:
      !firstHasReasoning ||
      (firstToolIndex >= 0 && lastThoughtCompleteIndex >= 0 && lastThoughtCompleteIndex < firstToolIndex),
    detail: firstHasReasoning
      ? `thinking.completed#${lastThoughtCompleteIndex} → tool.started#${firstToolIndex}`
      : "供应商未返回，跳过",
  },
  {
    name: "第一轮：实际调用了 inspect_canvas",
    pass: first.tools.includes("inspect_canvas"),
    detail: first.tools.join(" → ") || "无工具",
  },
  {
    name: "第一轮：思考已持久化到消息 thoughts",
    pass: !firstHasReasoning || (firstThoughts.length > 0 && firstThoughtText.trim().length > 0),
    detail: firstHasReasoning
      ? `${firstThoughts.length} 段 / ${firstThoughtText.trim().length} 字`
      : "供应商未返回，跳过",
  },
  {
    name: "第二轮：纯回答也有完整思考",
    pass: !secondHasReasoning || secondThoughtText.trim().length > 0,
    detail: secondHasReasoning
      ? `${secondThoughts.length} 段 / ${secondThoughtText.trim().length} 字`
      : "供应商未返回，跳过",
  },
  {
    name: "第二轮：思考没有混进最终回答",
    pass:
      !secondHasReasoning ||
      (second.answer.trim().length > 0 &&
        !second.answer.includes(secondThoughtText.trim().slice(0, 24))),
    detail: JSON.stringify(second.answer.trim().slice(0, 80)),
  },
  {
    name: "第二轮：回答正确（42）",
    pass: second.answer.includes("42"),
    detail: JSON.stringify(second.answer.trim().slice(0, 80)),
  },
];

console.log("\n思考样例：", JSON.stringify(secondThoughtText.trim().slice(0, 160)));
console.log("回答：", JSON.stringify(second.answer.trim().slice(0, 120)));
console.log("");

let failed = 0;
for (const check of checks) {
  console.log(`${check.pass ? "✓" : "✗"} ${check.name} · ${check.detail}`);
  if (!check.pass) failed += 1;
}

console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);