/**
 * 灵感搜索未配置时的行为探针：用户说“没什么灵感”。
 * 期望：真的调用 search_inspiration（过程里出现失败并标红），说明不可用，
 * 然后给文字方向/提问卡；不能假装搜过，也不能反复重试。
 *
 * 用法：pnpm --filter @my-lovart/server run:inspiration-unavailable-probe
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
const text = "我想制作5秒咖啡广告，没什么灵感";
const userMessage = await service.appendUserMessage(projectId, text, []);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240_000);
const toolStarts = [];
const toolFailures = [];

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
    if (event.type === "tool.started") toolStarts.push(event.tool.tool);
    if (event.type === "tool.failed") toolFailures.push(event.error);
  }
} finally {
  clearTimeout(timer);
}

const snapshot = await service.get(projectId);
const assistant = [...snapshot.messages].reverse().find((m) => m.role === "assistant");
const finalText = assistant?.content ?? "";

const assertions = [
  {
    name: "确实调用了 search_inspiration",
    pass: toolStarts.includes("search_inspiration"),
    detail: toolStarts.join(" → ") || "无工具",
  },
  {
    name: "搜索失败在过程里可见（invalid_config）",
    pass: toolFailures.some((error) => error.code === "invalid_config"),
    detail: toolFailures.map((error) => error.code).join(",") || "无失败",
  },
  {
    name: "没有反复重试搜图",
    pass: toolStarts.filter((tool) => tool === "search_inspiration").length === 1,
    detail: `${toolStarts.filter((tool) => tool === "search_inspiration").length} 次`,
  },
  {
    name: "说明搜图不可用，没有假装有结果",
    pass: /搜图|搜索|灵感/.test(finalText) && /不可用|没配置|缺少|暂时/.test(finalText),
    detail: finalText.slice(0, 160),
  },
  {
    name: "失败后仍给用户可继续的选项/文字方向",
    pass: /[？?]/.test(finalText) || (assistant?.questions?.length ?? 0) > 0,
    detail: `${assistant?.questions?.length ?? 0} 个问题`,
  },
];

const outDir = resolve(process.cwd(), "../../verification/inspiration-unavailable-2026-11-17");
await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(outDir, "transcript.json"),
  JSON.stringify({ text, toolStarts, toolFailures, finalText, assertions }, null, 2),
);

for (const item of assertions) {
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
const failed = assertions.filter((item) => !item.pass).length;
console.log(`\n${assertions.length - failed}/${assertions.length} 通过`);
console.log(`JSON: ${resolve(outDir, "transcript.json")}`);
process.exit(failed === 0 ? 0 : 1);