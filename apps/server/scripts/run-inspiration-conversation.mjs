/**
 * 灵感方向 → 文字选图 → 概念图 的真实模型回放（假 Pexels + 假方舟出图）。
 *
 * 为什么不用真 key：
 * - Pexels 配额小，契约已在 verify:inspiration 覆盖，这边验证的是「Agent 会不会用」；
 * - 出图走假方舟，避免真实生图额度；但模型、工具、SSE、资产管线都是真的。
 *
 * 断言：
 * 1. 第一轮只调用 search_inspiration，不生成图/视频；
 * 2. 灵感卡片在对话里，不说“已生成到画布”；
 * 3. 第二轮用户用“第 2 组第 2 张”选图，Agent 不再搜图，直接把该 imageUrl 作为 inputImages；
 * 4. 全程没有 generate_video。
 *
 * 用法：pnpm --filter @my-lovart/server run:inspiration-conversation
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
process.env.METASO_API_KEY = "";
process.env.PEXELS_API_KEY = "probe-pexels-key";

const realFetch = globalThis.fetch;

const PEXELS_CALLS = [];
const ARK_REQUESTS = [];
const DOWNLOADS = [];

const PALETTE = ["#e8e2d6", "#c9d4c5", "#b7c4d1", "#d9c3b0", "#c4b7d1", "#d1c7a8"];

function svgThumb(label, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="${color}"/><text x="24" y="330" font-family="system-ui,sans-serif" font-size="22" fill="#2b2b2b">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function photoUrl(id, size = "large2x") {
  return `https://images.pexels.com/photos/${id}/${size}.jpg`;
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(typeof input === "string" ? input : input?.url ?? input);

  if (url.startsWith("https://images.pexels.com/")) {
    const match = /photos\/(\d+)\//.exec(url);
    const id = match ? Number(match[1]) : 0;
    const group = Math.floor(id / 100);
    const index = (id % 100) - 1;
    const color = PALETTE[(Math.max(1, group) - 1 + Math.max(0, index)) % PALETTE.length];
    return new Response(svgThumb(`G${group}-${index + 1}`, color), {
      status: 200,
      headers: { "content-type": "image/svg+xml" },
    });
  }

  if (url.startsWith("https://api.pexels.com/")) {
    const parsed = new URL(url);
    const query = parsed.searchParams.get("query") ?? "";
    const perPage = Number(parsed.searchParams.get("per_page") ?? 4);
    const group = PEXELS_CALLS.length + 1;
    const items = Array.from({ length: Math.min(6, Math.max(2, perPage)) }, (_, index) => {
      const id = group * 100 + index + 1;
      const title = `${query} 参考 ${index + 1}`;
      return {
        id,
        width: 1200,
        height: 900,
        url: `https://www.pexels.com/photo/${id}`,
        photographer: "Probe",
        alt: title,
        src: { large2x: photoUrl(id), large: photoUrl(id, "large") },
      };
    });
    PEXELS_CALLS.push({ query, orientation: parsed.searchParams.get("orientation"), group, items: items.length });
    return new Response(JSON.stringify({ photos: items }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (url.includes("ark.cn-beijing.volces.com") && url.includes("/images/generations")) {
    const body = JSON.parse(String(init.body ?? "{}"));
    ARK_REQUESTS.push({ model: body.model, prompt: body.prompt, size: body.size, image: body.image });
    return new Response(
      JSON.stringify({
        data: [
          {
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  if (url.startsWith("data:image/")) {
    DOWNLOADS.push(url.slice(0, 40));
    return new Response(decodeDataUrl(url), {
      status: 200,
      headers: { "content-type": url.slice(5, url.indexOf(";")) || "image/svg+xml" },
    });
  }

  return realFetch(input, init);
};

function decodeDataUrl(url) {
  const comma = url.indexOf(",");
  const meta = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  if (meta.includes(";base64")) return Buffer.from(payload, "base64");
  return Buffer.from(decodeURIComponent(payload), "utf8");
}

const { createWorkspaceService } = await import(
  "../dist/features/workspace/workspace.service.js"
);
const { getAssetsRepository } = await import("../dist/features/assets/assets.repository.js");

const OUT_DIR = resolve(process.cwd(), "../../verification/inspiration-conversation-2026-11-16");
const projectId = randomUUID();
const service = createWorkspaceService(Promise.resolve(null));

const turns = [
  "我想给一款白色保温杯做条短视频，但风格还没想好。你先帮我找几组参考方向，我看看喜欢哪种。",
  "第 2 组第 2 张那种感觉可以。先用它做一张保温杯概念图，16:9，干净一点；视频先别做。",
];

const runLogs = [];

for (const [index, text] of turns.entries()) {
  console.log(`\n===== 第 ${index + 1} 轮 =====\n${text}`);
  const startedAt = Date.now();
  const userMessage = await service.appendUserMessage(projectId, text, []);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  const events = [];
  const turnTools = [];
  try {
    for await (const event of service.run(
      projectId,
      {
        text,
        kind: "auto",
        attachments: [],
        userMessageId: userMessage.id,
        baseUrl: "http://127.0.0.1:3001",
        rawAttachmentCount: 0,
      },
      controller.signal,
    )) {
      events.push(event);
      if (event.type === "tool.started") {
        turnTools.push(event.tool.tool);
        console.log(`  tool: ${event.tool.tool} · ${event.tool.title}`);
      }
      if (event.type === "tool.failed") console.log(`  tool failed: ${event.error.code} ${event.error.message}`);
      if (event.type === "artifact.ready") {
        console.log(`  artifact: ${event.artifact.type} · ${event.artifact.title ?? ""}`);
      }
      if (event.type === "run.failed") console.log(`  run failed: ${event.error.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
  runLogs.push({
    turn: index + 1,
    text,
    durationMs: Date.now() - startedAt,
    events: events.length,
    tools: turnTools,
  });
  console.log(`  done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  if (index < turns.length - 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

const snapshot = await service.get(projectId);
const assistantTexts = snapshot.messages.filter((m) => m.role === "assistant").map((m) => m.content);
const toolNames = snapshot.messages.flatMap((message) =>
  (message.blocks ?? []).filter((block) => block.type === "tool").map((block) => block.tool),
);
const assetsRepo = await getAssetsRepository();
const assets = await assetsRepo.list(projectId, 50);

const group2Item2 = PEXELS_CALLS[1] ? "G2-2" : "";
const expectedRef = group2Item2 ? photoUrl(202) : "";
const arkImageRefs = ARK_REQUESTS.flatMap((request) =>
  Array.isArray(request.image) ? request.image : request.image ? [request.image] : [],
);

const turn1Tools = runLogs[0]?.tools ?? [];
const turn2Tools = runLogs[1]?.tools ?? [];

const assertions = [
  {
    name: "第一轮只搜灵感，不生成图/视频",
    pass:
      turn1Tools.length === 1 &&
      turn1Tools[0] === "search_inspiration" &&
      PEXELS_CALLS.length >= 2,
    detail: `${turn1Tools.join(" → ") || "无工具"} / ${PEXELS_CALLS.length} 组查询`,
  },
  {
    name: "灵感卡片在对话里，没说“已生成到画布”",
    pass: !assistantTexts.some((text) => /已?生成到画布|放到画布上|已加入画布/.test(text)),
    detail: assistantTexts[0]?.slice(0, 80) ?? "",
  },
  {
    name: "第二轮没有重新搜图",
    pass: !turn2Tools.includes("search_inspiration"),
    detail: turn2Tools.join(" → ") || "无工具",
  },
  {
    name: "“第 2 组第 2 张”选中图进入了 inputImages",
    pass: Boolean(expectedRef) && arkImageRefs.includes(expectedRef),
    detail: `inputImages ${arkImageRefs.length} 张`,
  },
  {
    name: "没有越过用户要求去生成视频",
    pass: toolNames.every((name) => name !== "generate_video") &&
      assets.every((asset) => asset.kind !== "video"),
    detail: `${toolNames.filter((name) => name === "generate_video").length} 次视频工具`,
  },
];

const failures = assertions.filter((item) => !item.pass);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(
  resolve(OUT_DIR, "transcript.json"),
  JSON.stringify(
    {
      turns,
      runLogs,
      pexelsCalls: PEXELS_CALLS,
      arkRequests: ARK_REQUESTS,
      assistantTexts,
      toolNames,
      assets: assets.map((asset) => ({ id: asset.id, kind: asset.kind, title: asset.title, url: asset.url })),
      assertions,
    },
    null,
    2,
  ),
);
await writeFile(resolve(OUT_DIR, "index.html"), renderHtml());

for (const item of assertions) {
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
console.log(`\n${assertions.length - failures.length}/${assertions.length} 通过`);
console.log(`HTML: ${resolve(OUT_DIR, "index.html")}`);
process.exitCode = failures.length === 0 ? 0 : 1;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function renderHtml() {
  const cards = PEXELS_CALLS.map(
    (call) => `
      <section class="group">
        <header><span>第 ${call.group} 组</span><strong>${escapeHtml(call.query)}</strong></header>
        <div class="grid">
          ${Array.from({ length: call.items }, (_, index) => {
            const color = PALETTE[(call.group - 1 + index) % PALETTE.length];
            return `<figure><img src="${svgThumb(`G${call.group}-${index + 1}`, color)}" alt="G${call.group}-${index + 1}" /><figcaption>${call.group}.${index + 1} · ${escapeHtml(call.query)} 参考 ${index + 1}</figcaption></figure>`;
          }).join("")}
        </div>
      </section>`,
  ).join("");

  const messages = snapshot.messages
    .map((message) => {
      const toolBlocks = (message.blocks ?? []).filter((block) => block.type === "tool");
      const tools = toolBlocks
        .map((block) => `<li>${escapeHtml(block.tool)} · ${escapeHtml(block.title ?? "")}</li>`)
        .join("");
      return `
        <article class="msg ${message.role}">
          <div class="who">${message.role === "user" ? "用户" : "Agent"}</div>
          <div class="body">${message.content ? `<p>${escapeHtml(message.content).replace(/\n/g, "<br />")}</p>` : ""}${tools ? `<ul class="tools">${tools}</ul>` : ""}</div>
        </article>`;
    })
    .join("");

  const checks = assertions
    .map(
      (item) =>
        `<li class="${item.pass ? "ok" : "bad"}"><span>${item.pass ? "✓" : "✕"}</span>${escapeHtml(item.name)}<em>${escapeHtml(item.detail)}</em></li>`,
    )
    .join("");

  const ark = ARK_REQUESTS.map(
    (request) =>
      `<li><code>${escapeHtml(request.model)}</code> · ${escapeHtml(request.size)} · inputImages ${Array.isArray(request.image) ? request.image.length : request.image ? 1 : 0} 张</li>`,
  ).join("");

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>灵感方向 → 文字选图 → 概念图</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#f5f3ee;color:#20201e;font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif}
  main{max-width:920px;margin:0 auto;padding:48px 24px 72px}
  h1{font-size:26px;line-height:1.35;margin:0 0 8px}
  .sub{color:#6c6a64;margin:0 0 28px}
  h2{font-size:15px;margin:36px 0 12px;letter-spacing:.04em;text-transform:uppercase;color:#6c6a64}
  .group{border:1px solid #e2ded4;border-radius:14px;background:#fffdf9;padding:14px;margin-bottom:12px}
  .group header{display:flex;gap:10px;align-items:baseline;margin-bottom:10px}
  .group header span{font-size:11px;color:#8a877e}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  figure{margin:0}
  figure img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;display:block}
  figcaption{font-size:11px;color:#6c6a64;margin-top:4px}
  .msg{display:grid;grid-template-columns:64px 1fr;gap:12px;padding:12px 0;border-bottom:1px solid #e8e4da}
  .who{font-size:11px;color:#8a877e;padding-top:2px}
  .msg.user .body{background:#efece4;border-radius:12px;padding:10px 14px}
  .tools{margin:8px 0 0;padding-left:16px;font-size:12px;color:#6c6a64}
  ul.checks{list-style:none;padding:0;margin:0}
  ul.checks li{display:flex;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid #e8e4da}
  ul.checks li span{font-weight:600}
  ul.checks li.ok span{color:#2f7d54}
  ul.checks li.bad span{color:#b23a3a}
  ul.checks li em{margin-left:auto;font-style:normal;font-size:11px;color:#8a877e}
  pre{background:#1f1f1d;color:#eee;border-radius:12px;padding:14px;overflow:auto;font-size:12px}
</style></head>
<body><main>
  <h1>风格没想好时：先给方向，再让用户用一句话选图</h1>
  <p class="sub">真实模型 + 假 Pexels + 假方舟出图。用户只说“风格还没想好”，第二轮只回复“第 2 组第 2 张那种感觉”，看 Agent 能不能自己定位到那张参考图并带进生成。</p>

  <h2>对话</h2>
  ${messages}

  <h2>灵感卡片（编号与界面一致）</h2>
  ${cards}

  <h2>服务端收到的生成请求</h2>
  <ul class="checks">${ark || "<li>没有生图请求</li>"}</ul>

  <h2>断言</h2>
  <ul class="checks">${checks}</ul>

  <h2>说明</h2>
  <p class="sub">Pexels 调用 ${PEXELS_CALLS.length} 次；生成请求 ${ARK_REQUESTS.length} 次。真实 Pexels 搜索需要把 PEXELS_API_KEY 填进 .env.local，接口契约已由 verify:inspiration 覆盖。</p>
</main></body></html>`;
}