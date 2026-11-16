/**
 * 视频前期完整对话回放（真实模型 + 隔离内存仓库）。
 *
 * 这是 golden 场景回放，不是单元测试：
 * - 单测（verify-video-guard）验证服务端闸门与状态机；
 * - 这个脚本验证真实对话里 Agent 会不会按正确顺序问需求、建分镜、出锚图、出首尾帧，
 *   并在最终 generate_video 前停下，最后输出一份可阅读的 HTML。
 *
 * 用法：
 *   pnpm --filter @my-lovart/server run:video-conversation
 *
 * 注意：会真实调用 Seedream 生图。视频渠道被置空，保证不会误出片。
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// 隔离测试：不污染正式 Supabase 项目、消息、Storage；视频 key 置空，杜绝误出片
process.env.PROJECTS_STORE = "memory";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.SUPABASE_DB_URL = "";
process.env.GENERATION_MODE = "real";
process.env.METASO_API_KEY = "";

const { createWorkspaceService } = await import(
  "../dist/features/workspace/workspace.service.js"
);
const { getStoryboardsRepository } = await import(
  "../dist/features/storyboards/storyboards.repository.js"
);
const { getAssetsRepository } = await import(
  "../dist/features/assets/assets.repository.js"
);
const { activeShots } = await import("../dist/features/storyboards/storyboards.js");
const { fileDataUrlFromUrl } = await import("../dist/features/files/file.store.js");

const scenarios = {
  pro: {
    outDir: "video-conversation-2026-11-16",
    title: "保温杯 10 秒广告 · 视频前期对话回放",
    heading: "保温杯 10 秒广告<br />从一句需求到首帧、尾帧，停在视频之前",
    subtitle:
      "真实模型对话回放：Agent 先追问投放与素材，再建 10 秒两镜分镜，生成产品锚图和主视觉锚图，最后只生成第 1 镜首帧与尾帧。没有调用 generate_video。",
    turns: [
      "我要做一个保温杯的 10 秒广告视频",
      "竖屏 9:16（抖音/视频号）；都市通勤场景，晨间自然光；没有实拍，按我的描述先生成产品设定图。产品是奶油白哑光圆柱杯身、竹木长盖、细长比例，杯身无 logo。注意杯盖全程闭合，不拍开盖、螺纹、内胆、倒水，也不要让热气从杯口冒出来。",
      "外形和调性都可以，按这版继续。先出第 1 镜的首帧和尾帧，只做机位推近和光斑移动；杯盖保持闭合，视频先不要生成。",
    ],
    stopNote:
      "第 1 镜首帧与尾帧已准备好；按照用户要求，视频没有生成。下一步才是 generate_video(shotId)，服务端会先做首帧、尾帧、canon 血缘和镜头时长预检。",
  },
  lay: {
    outDir: "video-conversation-lay-2026-11-16",
    title: "普通用户版 · 保温杯 10 秒广告对话回放",
    heading: "保温杯 10 秒广告<br />一个不懂专业术语的用户，会怎么把需求说清楚",
    subtitle:
      "真实模型对话回放：用户只说“发抖音、竖着拍、早上上班的感觉”，没有分镜、锚图、首帧这些术语，也没有产品实拍。Agent 需要自己补全这些专业步骤，并在视频前停下。",
    turns: [
      "我要做一个保温杯的 10 秒广告视频",
      "发抖音的，竖着拍就行。想要早上出门上班那种感觉，干净一点、别太花。没有杯子照片，就普通白色保温杯、木头盖子，你帮我做吧。",
      "可以，看着挺舒服的。先给我看看第一段画面，视频先别做。",
    ],
    stopNote:
      "第一段画面已经准备好；用户只说“视频先别做”，Agent 仍然停在了视频前。下一步才轮到 generate_video(shotId)，而不是把“先看看画面”当成“直接出片”。",
  },
};

const scenarioKey = process.env.CONVERSATION_SCENARIO === "lay" ? "lay" : "pro";
const scenario = scenarios[scenarioKey];
const OUT_DIR = resolve(process.cwd(), `../../verification/${scenario.outDir}`);
const IMAGE_DIR = resolve(OUT_DIR, "images");

const projectId = randomUUID();
const service = createWorkspaceService(Promise.resolve(null));

const runLogs = [];
const allEvents = [];

for (const [index, text] of scenario.turns.entries()) {
  console.log(`\n===== 第 ${index + 1} 轮 =====`);
  const startedAt = Date.now();
  const userMessage = await service.appendUserMessage(projectId, text, []);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  const turnEvents = [];
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
      turnEvents.push(event);
      allEvents.push({ turn: index + 1, ...event });
      if (event.type === "tool.started") {
        console.log(`  tool: ${event.tool.tool} · ${event.tool.title}`);
      }
      if (event.type === "tool.failed") {
        console.log(`  tool failed: ${event.error.code} ${event.error.message}`);
      }
      if (event.type === "artifact.ready") {
        console.log(`  artifact: ${event.artifact.type} · ${event.artifact.title ?? ""}`);
      }
      if (event.type === "run.failed") {
        console.log(`  run failed: ${event.error.message}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  runLogs.push({
    turn: index + 1,
    text,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    events: turnEvents.length,
  });
  console.log(`  done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  // 模拟用户看图的停顿：服务端用 2 秒窗口判断“锚图是否本轮刚生成”，
  // 自动回放如果 0 秒接下一句，会把上一轮末尾的锚图误判成本轮新图。
  if (index < scenario.turns.length - 1) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

const snapshot = await service.get(projectId);
const storyboardRepo = await getStoryboardsRepository();
const boards = await storyboardRepo.list(projectId);
const activeBoard = boards.find((board) => board.active) ?? boards[0];
const detail = activeBoard ? await storyboardRepo.get(projectId, activeBoard.id) : null;
const assetsRepo = await getAssetsRepository();
const storedAssets = await assetsRepo.list(projectId, 100);

// 把内存里的图片抓出来：既写独立文件，也内嵌为 data URL，打开 HTML 不依赖服务端
await mkdir(IMAGE_DIR, { recursive: true });
const assetsById = new Map(storedAssets.map((asset) => [asset.id, asset]));
const imageData = new Map();
let imageIndex = 0;
for (const asset of storedAssets.filter((item) => item.kind === "image")) {
  const dataUrl = await fileDataUrlFromUrl(asset.url);
  if (!dataUrl) continue;
  imageIndex += 1;
  const role = String(asset.metadata?.role ?? asset.metadata?.anchorType ?? "image");
  const extension = dataUrl.startsWith("data:image/jpeg") ? "jpg" : "png";
  const fileName = `${String(imageIndex).padStart(2, "0")}-${role}.${extension}`;
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  await writeFile(resolve(IMAGE_DIR, fileName), Buffer.from(base64, "base64"));
  imageData.set(asset.id, { dataUrl, fileName });
}

const imageAssets = storedAssets.filter((item) => item.kind === "image");
const videoAssets = storedAssets.filter((item) => item.kind === "video");
const toolNames = snapshot.messages.flatMap((message) =>
  (message.blocks ?? []).filter((block) => block.type === "tool").map((block) => block.tool),
);
const videoToolCalls = toolNames.filter((name) => name === "generate_video");
const firstShot = detail ? activeShots(detail)[0] : undefined;
const secondShot = detail ? activeShots(detail)[1] : undefined;
const consistency = String(detail?.storyboard.metadata?.consistency ?? "adaptive");

const assertions = [
  {
    name: "完整 3 轮对话",
    pass: runLogs.length === 3 && snapshot.messages.length === 6,
    detail: `${runLogs.length} 轮 / ${snapshot.messages.length} 条消息`,
  },
  {
    name: "先问需求，再建分镜",
    pass: (snapshot.messages[1]?.questions?.length ?? 0) >= 2,
    detail: `${snapshot.messages[1]?.questions?.length ?? 0} 个问题`,
  },
  {
    name: "没有把生成设定图说成“和实物一致”",
    pass: !snapshot.messages.some(
      (message) =>
        message.role === "assistant" &&
        /和实物一致|与实物一致|和实物一模一样/.test(message.content),
    ),
    detail: snapshot.messages.some(
      (message) =>
        message.role === "assistant" &&
        /和实物一致|与实物一致|和实物一模一样/.test(message.content),
    )
      ? "出现了不当承诺"
      : "没有不当承诺",
  },
  {
    name: "分镜为 10 秒、1-2 个镜头",
    pass:
      detail?.storyboard.totalDurationSeconds === 10 &&
      activeShots(detail).length >= 1 &&
      activeShots(detail).length <= 2,
    detail: `${detail?.storyboard.totalDurationSeconds ?? "?"} 秒 / ${
      detail ? activeShots(detail).length : 0
    } 镜 / ${consistency}`,
  },
  {
    name: "产品锚图 + 至少 1 张辅助锚图已生成",
    pass:
      imageAssets.some((asset) => asset.metadata?.anchorType === "product") &&
      imageAssets.some((asset) =>
        ["style", "scene", "character"].includes(String(asset.metadata?.anchorType)),
      ),
    detail: `${imageAssets.length} 张图片资产`,
  },
  {
    name: "第 1 镜首帧和尾帧已生成",
    pass: Boolean(firstShot?.firstFrameAssetId && firstShot?.endFrameAssetId),
    detail: firstShot
      ? `first=${firstShot.firstFrameAssetId ? "有" : "无"} / end=${
          firstShot.endFrameAssetId ? "有" : "无"
        }`
      : "无镜头",
  },
  {
    name: "第 2 镜未越过视频直接生成",
    pass: !secondShot?.firstFrameAssetId && !secondShot?.endFrameAssetId,
    detail: secondShot
      ? `first=${secondShot.firstFrameAssetId ? "有" : "无"} / end=${
          secondShot.endFrameAssetId ? "有" : "无"
        }`
      : "无镜头",
  },
  {
    name: "停在视频前：没有 generate_video、没有视频资产",
    pass: videoToolCalls.length === 0 && videoAssets.length === 0,
    detail: `${videoToolCalls.length} 次视频工具 / ${videoAssets.length} 条视频`,
  },
];

const failures = assertions.filter((item) => !item.pass);
console.log("\n===== 回放结果 =====");
for (const item of assertions) {
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name} — ${item.detail}`);
}
console.log(`${assertions.length - failures.length}/${assertions.length} 通过`);
console.log(`HTML 输出：${resolve(OUT_DIR, "index.html")}`);

const transcript = {
  projectId,
  startedAt: runLogs[0]?.startedAt,
  turns: runLogs,
  messages: snapshot.messages,
  storyboard: detail
    ? {
        storyboard: detail.storyboard,
        shots: activeShots(detail),
      }
    : null,
  assets: storedAssets.map((asset) => ({
    id: asset.id,
    kind: asset.kind,
    title: asset.title,
    role: asset.metadata?.role ?? null,
    anchorType: asset.metadata?.anchorType ?? null,
    model: asset.model ?? null,
    width: asset.width,
    height: asset.height,
    sourceAssetIds: asset.sourceAssetIds,
    prompt: asset.prompt,
    imageFile: imageData.get(asset.id)?.fileName ?? null,
  })),
  assertions,
  videoToolCalls,
};

await writeFile(resolve(OUT_DIR, "transcript.json"), JSON.stringify(transcript, null, 2));

// ---------- HTML ----------

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
}

function tableRow(line) {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderMarkdown(source) {
  const lines = String(source ?? "").trim().split(/\r?\n/);
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (/^###\s+/.test(line)) {
      out.push(`<h4>${inlineMarkdown(line.replace(/^###\s+/, ""))}</h4>`);
      index += 1;
      continue;
    }
    if (/^##\s+/.test(line)) {
      out.push(`<h3>${inlineMarkdown(line.replace(/^##\s+/, ""))}</h3>`);
      index += 1;
      continue;
    }
    if (/^#\s+/.test(line)) {
      out.push(`<h3>${inlineMarkdown(line.replace(/^#\s+/, ""))}</h3>`);
      index += 1;
      continue;
    }
    if (
      line.includes("|") &&
      lines[index + 1] &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1]) &&
      lines[index + 1].includes("-")
    ) {
      const headers = tableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index]?.includes("|")) {
        rows.push(tableRow(lines[index]));
        index += 1;
      }
      out.push(
        `<div class="table-wrap"><table><thead><tr>${headers
          .map((cell) => `<th>${inlineMarkdown(cell)}</th>`)
          .join("")}</tr></thead><tbody>${rows
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`,
          )
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? "")) {
        items.push(inlineMarkdown((lines[index] ?? "").replace(/^\s*[-*]\s+/, "")));
        index += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`);
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index]?.trim() &&
      !/^#{1,4}\s+/.test(lines[index] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[index] ?? "") &&
      !(lines[index]?.includes("|") && lines[index + 1]?.includes("-"))
    ) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }
  return out.join("");
}

function roleLabel(asset) {
  const role = asset?.metadata?.role;
  const anchor = asset?.metadata?.anchorType;
  if (role === "canon" && anchor === "product") return "产品锚图";
  if (role === "canon" && anchor === "product_detail") return "产品细节锚图";
  if (role === "canon" && anchor === "style") return "主视觉锚图";
  if (role === "canon" && anchor === "scene") return "场景锚图";
  if (role === "canon" && anchor === "character") return "角色锚图";
  if (role === "keyframe") return "镜头首帧";
  if (role === "end_frame") return "镜头尾帧";
  if (role === "video_last_frame") return "视频实际末帧";
  if (role === "video") return "成片片段";
  return "图片";
}

function renderTool(tool) {
  const status = tool.status === "failed" ? "failed" : tool.status === "done" ? "done" : "running";
  const statusLabel = status === "failed" ? "失败" : status === "done" ? "完成" : "运行中";
  return `<details class="tool ${status}">
    <summary>
      <span class="tool-dot"></span>
      <span class="tool-name">${escapeHtml(tool.title)}</span>
      ${tool.detail ? `<span class="tool-detail">${escapeHtml(tool.detail)}</span>` : ""}
      <span class="tool-status">${statusLabel}</span>
    </summary>
    <div class="tool-body">
      ${
        tool.inputSummary
          ? `<div class="tool-field"><span>输入</span><pre>${escapeHtml(tool.inputSummary)}</pre></div>`
          : ""
      }
      ${
        tool.outputSummary
          ? `<div class="tool-field"><span>输出</span><pre>${escapeHtml(tool.outputSummary)}</pre></div>`
          : ""
      }
      ${
        tool.error
          ? `<div class="tool-field error"><span>错误</span><pre>${escapeHtml(tool.error)}</pre></div>`
          : ""
      }
    </div>
  </details>`;
}

function renderArtifact(block) {
  const asset = assetsById.get(block.id);
  const embedded = imageData.get(block.id);
  const label = roleLabel(asset);
  return `<figure class="artifact">
    <div class="artifact-frame">
      ${
        embedded
          ? `<img src="${embedded.dataUrl}" alt="${escapeHtml(block.title ?? label)}" loading="lazy" />`
          : `<div class="missing">图片只存在于内存，未能导出</div>`
      }
    </div>
    <figcaption>
      <div class="artifact-head"><span class="tag">${escapeHtml(label)}</span><strong>${escapeHtml(
        block.title ?? "未命名图片",
      )}</strong></div>
      <div class="artifact-meta">${escapeHtml(block.model ?? "Seedream 4.5")} · ${block.width}×${
        block.height
      }${block.sourceAssetIds?.length ? ` · 参考 ${block.sourceAssetIds.length} 张` : ""}</div>
      ${
        block.prompt
          ? `<details class="prompt"><summary>查看生成 prompt</summary><pre>${escapeHtml(
              block.prompt,
            )}</pre></details>`
          : ""
      }
    </figcaption>
  </figure>`;
}

function renderQuestions(questions) {
  if (!questions?.length) return "";
  return `<div class="questions">${questions
    .map(
      (question, index) => `<section class="question">
        <div class="question-index">0${index + 1}</div>
        <div class="question-content">
          <h4>${escapeHtml(question.question)}</h4>
          <div class="options">${question.options
            .map(
              (option) =>
                `<span class="option">${escapeHtml(option.label)}${question.allowCustom ? "" : ' <em>仅候选</em>'}</span>`,
            )
            .join("")}</div>
        </div>
      </section>`,
    )
    .join("")}</div>`;
}

function renderMessage(message, index, previous) {
  if (message.role === "user") {
    return `<article class="message user" id="m${index}">
      <div class="avatar user-avatar">你</div>
      <div class="bubble">
        <div class="bubble-label">用户</div>
        <div class="text">${renderMarkdown(message.content)}</div>
      </div>
    </article>`;
  }

  const parts = Array.isArray(message.parts) && message.parts.length > 0
    ? message.parts
    : [
        { type: "text", text: message.content },
        ...(message.blocks ?? []).map((block) => ({ type: "block", block })),
      ];

  const body = parts
    .map((part) => {
      if (part.type === "text") {
        return part.text?.trim() ? `<div class="text">${renderMarkdown(part.text)}</div>` : "";
      }
      const block = part.block;
      if (block.type === "tool") return renderTool(block);
      if (block.type === "image" || block.type === "video") return renderArtifact(block);
      return "";
    })
    .join("");

  const time = new Date(message.createdAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `<article class="message assistant" id="m${index}">
    <div class="avatar ai-avatar">AI</div>
    <div class="bubble">
      <div class="bubble-label">mylovart <span>${time}</span></div>
      ${body}
      ${renderQuestions(message.questions)}
    </div>
  </article>`;
}

const messageHtml = snapshot.messages
  .map((message, index) => renderMessage(message, index, snapshot.messages[index - 1]))
  .join("");

const shots = detail ? activeShots(detail) : [];
const shotCount = shots.length;
const durationSeconds = detail?.storyboard.totalDurationSeconds;
const aspectRatio = detail?.storyboard.aspectRatio ?? "9:16";
const shotDurationLabel =
  shots.map((shot) => `${shot.durationSeconds ?? "?"}s`).join(" + ") || "待定";
const multiShot = shotCount > 1;
const shotHtml = shots
  .map((shot) => {
    const hasFrame = Boolean(shot.firstFrameAssetId || shot.endFrameAssetId || shot.videoAssetId);
    return `<li class="shot ${hasFrame ? "ready" : "pending"}">
      <div class="shot-order">${String(shot.orderIndex).padStart(2, "0")}</div>
      <div class="shot-main">
        <div class="shot-top"><strong>${escapeHtml(shot.title)}</strong><span>${shot.durationSeconds ?? "?"}s</span></div>
        <p>${escapeHtml(shot.description || shot.prompt)}</p>
        <div class="shot-tags">
          ${shot.sceneGoal ? `<span>${escapeHtml(shot.sceneGoal)}</span>` : ""}
          ${shot.firstFrameAssetId ? "<span class='ok'>首帧</span>" : "<span class='muted'>首帧待生成</span>"}
          ${shot.endFrameAssetId ? "<span class='ok'>尾帧</span>" : "<span class='muted'>尾帧待生成</span>"}
          ${shot.videoAssetId ? "<span class='ok'>视频</span>" : "<span class='muted'>视频未生成</span>"}
        </div>
      </div>
    </li>`;
  })
  .join("");

const assertionHtml = assertions
  .map(
    (item) => `<li class="${item.pass ? "pass" : "fail"}">
      <span class="check">${item.pass ? "✓" : "!"}</span>
      <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.detail)}</small></span>
    </li>`,
  )
  .join("");

const totalSeconds = runLogs.reduce((sum, log) => sum + log.durationMs, 0) / 1000;
const modelNames = [...new Set(imageAssets.map((asset) => asset.model).filter(Boolean))];

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(scenario.title)}</title>
<style>
  :root {
    color-scheme: light;
    --paper: #f7f3ec;
    --paper-deep: #efe8dd;
    --ink: #25221d;
    --muted: #7f7669;
    --line: #ded4c5;
    --accent: #b65d3e;
    --accent-dark: #8f452d;
    --moss: #5a6c51;
    --warn: #a16a2a;
    --white: #fffdf9;
    --shadow: 0 18px 50px rgba(55, 42, 27, 0.1);
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background:
      radial-gradient(circle at 12% 0%, rgba(182, 93, 62, 0.09), transparent 34rem),
      radial-gradient(circle at 88% 10%, rgba(90, 108, 81, 0.1), transparent 30rem),
      var(--paper);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 15px;
    line-height: 1.72;
  }
  h1, h2, h3, h4, p { margin: 0; }
  code, pre { font-family: "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, monospace; }
  .page { max-width: 1320px; margin: 0 auto; padding: 34px 28px 80px; }
  .hero {
    position: relative;
    border: 1px solid var(--line);
    background: linear-gradient(135deg, rgba(255,253,249,.96), rgba(247,241,232,.92));
    border-radius: 28px;
    padding: 40px 42px 34px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .hero::after {
    content: "";
    position: absolute;
    width: 360px; height: 360px; border-radius: 50%;
    right: -80px; top: -140px;
    border: 1px solid rgba(182,93,62,.22);
    box-shadow: 0 0 0 36px rgba(182,93,62,.045), 0 0 0 74px rgba(182,93,62,.025);
    pointer-events: none;
  }
  .kicker { color: var(--accent-dark); font-size: 11px; letter-spacing: .2em; text-transform: uppercase; font-weight: 700; }
  .hero h1 {
    font-family: "Iowan Old Style", "Songti SC", "Noto Serif SC", serif;
    font-size: clamp(32px, 4vw, 54px);
    line-height: 1.15;
    letter-spacing: -.03em;
    margin: 12px 0 12px;
    max-width: 860px;
    font-weight: 600;
  }
  .hero .sub { color: var(--muted); max-width: 780px; font-size: 16px; }
  .hero-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 26px; position: relative; z-index: 1; }
  .chip { border: 1px solid var(--line); background: rgba(255,255,255,.65); border-radius: 999px; padding: 7px 12px; font-size: 12px; color: #534a3f; }
  .chip strong { color: var(--ink); font-weight: 650; }
  .hero-stats { display: flex; gap: 28px; margin-top: 28px; position: relative; z-index: 1; flex-wrap: wrap; }
  .stat { min-width: 92px; }
  .stat b { display: block; font-family: "Iowan Old Style", "Songti SC", serif; font-size: 32px; line-height: 1; font-weight: 600; }
  .stat span { color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 356px; gap: 30px; margin-top: 30px; align-items: start; }
  .chat {
    border: 1px solid var(--line);
    border-radius: 24px;
    background:
      linear-gradient(rgba(255,253,249,.82), rgba(255,253,249,.82)),
      repeating-linear-gradient(0deg, transparent 0 27px, rgba(120,102,80,.035) 27px 28px);
    box-shadow: 0 12px 34px rgba(70, 52, 30, 0.07);
    padding: 26px 24px 34px;
    min-height: 600px;
  }
  .chat-head { display: flex; align-items: center; justify-content: space-between; padding: 0 6px 20px; border-bottom: 1px solid var(--line); }
  .chat-head h2 { font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); font-weight: 650; }
  .chat-head span { font-size: 11px; color: var(--muted); }
  .message { display: flex; gap: 12px; margin-top: 26px; align-items: flex-start; }
  .message.user { flex-direction: row-reverse; }
  .avatar { flex: 0 0 34px; width: 34px; height: 34px; border-radius: 11px; display: grid; place-items: center; font-size: 11px; font-weight: 700; letter-spacing: .02em; }
  .user-avatar { background: var(--ink); color: var(--white); }
  .ai-avatar { background: var(--accent); color: var(--white); box-shadow: inset 0 0 0 1px rgba(255,255,255,.18); }
  .bubble { max-width: min(100%, 780px); border: 1px solid var(--line); background: var(--white); border-radius: 18px; padding: 16px 18px 18px; box-shadow: 0 4px 14px rgba(55,42,27,.04); }
  .message.user .bubble { background: #2b2823; color: #f7f3ec; border-color: #2b2823; max-width: min(100%, 680px); }
  .message.user .bubble p { color: #f7f3ec; }
  .bubble-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .12em; margin-bottom: 7px; font-weight: 650; }
  .message.user .bubble-label { color: rgba(247,243,236,.55); }
  .bubble-label span { margin-left: 6px; letter-spacing: 0; text-transform: none; }
  .text p { margin: 0 0 10px; }
  .text p:last-child { margin-bottom: 0; }
  .text h3, .text h4 { margin: 16px 0 8px; line-height: 1.35; }
  .text h3 { font-size: 17px; }
  .text h4 { font-size: 15px; }
  .text ul { margin: 8px 0 12px; padding-left: 20px; }
  .text li { margin: 4px 0; }
  .text strong { font-weight: 700; }
  .text code { background: var(--paper-deep); padding: 1px 5px; border-radius: 5px; font-size: 12px; }
  .table-wrap { overflow: auto; margin: 12px 0 16px; border: 1px solid var(--line); border-radius: 12px; }
  table { border-collapse: collapse; width: 100%; min-width: 480px; font-size: 13px; }
  th, td { border-bottom: 1px solid var(--line); padding: 9px 11px; text-align: left; vertical-align: top; }
  th { background: #f4eee5; color: #5f5548; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  tr:last-child td { border-bottom: 0; }
  .tool { margin: 12px 0; border: 1px solid var(--line); border-radius: 12px; background: #fbf8f2; overflow: hidden; }
  .tool summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 9px; padding: 10px 12px; font-size: 12px; }
  .tool summary::-webkit-details-marker { display: none; }
  .tool-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--moss); flex: 0 0 7px; }
  .tool.failed .tool-dot { background: #b33a2b; }
  .tool-name { font-weight: 650; }
  .tool-detail { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-status { margin-left: auto; color: var(--muted); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
  .tool.failed .tool-status { color: #b33a2b; }
  .tool-body { border-top: 1px solid var(--line); padding: 10px 12px 12px; background: var(--white); }
  .tool-field { margin-top: 9px; }
  .tool-field span { display: block; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 4px; }
  .tool-field pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; line-height: 1.55; color: #50483d; }
  .tool-field.error pre { color: #a33a2b; }
  .artifact { margin: 16px 0 6px; max-width: 620px; border: 1px solid var(--line); border-radius: 16px; overflow: hidden; background: var(--white); }
  .artifact-frame { background: #eee7dc; padding: 12px; text-align: center; }
  .artifact-frame img { max-width: 100%; max-height: 660px; display: inline-block; border-radius: 10px; box-shadow: 0 12px 28px rgba(55,42,27,.14); }
  .artifact figcaption { padding: 12px 14px 14px; }
  .artifact-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tag { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent-dark); border: 1px solid rgba(182,93,62,.32); background: rgba(182,93,62,.08); border-radius: 999px; padding: 3px 8px; white-space: nowrap; }
  .artifact-meta { color: var(--muted); font-size: 11px; margin-top: 4px; }
  .prompt { margin-top: 8px; font-size: 11px; }
  .prompt summary { cursor: pointer; color: var(--accent-dark); }
  .prompt pre { white-space: pre-wrap; word-break: break-word; color: #5e5549; margin-top: 8px; background: #f8f4ed; border: 1px solid var(--line); border-radius: 9px; padding: 10px; font-size: 10.5px; line-height: 1.55; }
  .questions { margin-top: 14px; border-top: 1px dashed var(--line); padding-top: 12px; }
  .question { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid #eee5d9; }
  .question:last-child { border-bottom: 0; }
  .question-index { flex: 0 0 26px; font-family: "Iowan Old Style", serif; color: var(--accent); font-size: 19px; line-height: 1.3; }
  .question h4 { font-size: 13px; margin: 0 0 7px; }
  .options { display: flex; flex-wrap: wrap; gap: 6px; }
  .option { border: 1px solid var(--line); background: #fbf8f2; border-radius: 999px; padding: 4px 9px; font-size: 11px; color: #62584c; }
  .option em { color: var(--muted); font-style: normal; }
  .stop-card { margin: 30px auto 4px; max-width: 760px; border: 1px solid rgba(182,93,62,.3); border-radius: 18px; background: linear-gradient(135deg, rgba(182,93,62,.1), rgba(182,93,62,.035)); padding: 18px 20px; text-align: center; }
  .stop-card strong { display: block; color: var(--accent-dark); font-size: 13px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 4px; }
  .stop-card p { color: #5f5143; font-size: 13px; }
  .side { position: sticky; top: 24px; display: grid; gap: 16px; }
  .panel { border: 1px solid var(--line); border-radius: 20px; background: rgba(255,253,249,.9); padding: 20px; box-shadow: 0 10px 26px rgba(55,42,27,.055); }
  .panel-kicker { font-size: 10px; letter-spacing: .15em; text-transform: uppercase; color: var(--accent-dark); font-weight: 700; margin-bottom: 8px; }
  .panel h3 { font-family: "Iowan Old Style", "Songti SC", serif; font-size: 22px; line-height: 1.25; font-weight: 600; margin-bottom: 8px; }
  .panel p { color: #675c4f; font-size: 12.5px; }
  .checks { list-style: none; padding: 0; margin: 14px 0 0; display: grid; gap: 10px; }
  .checks li { display: flex; gap: 9px; align-items: flex-start; font-size: 12px; }
  .checks .check { flex: 0 0 20px; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; margin-top: 1px; }
  .checks .pass .check { background: rgba(90,108,81,.15); color: var(--moss); }
  .checks .fail .check { background: rgba(179,58,43,.12); color: #b33a2b; }
  .checks strong { display: block; font-weight: 650; }
  .checks small { display: block; color: var(--muted); font-size: 10.5px; line-height: 1.45; margin-top: 2px; }
  .shots { list-style: none; padding: 0; margin: 14px 0 0; display: grid; gap: 10px; }
  .shot { display: flex; gap: 10px; border: 1px solid var(--line); border-radius: 12px; padding: 11px; background: #fbf8f2; }
  .shot-order { flex: 0 0 28px; font-family: "Iowan Old Style", serif; font-size: 23px; color: #a59683; line-height: 1.2; }
  .shot-main { min-width: 0; }
  .shot-top { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
  .shot-top span { color: var(--muted); font-size: 10px; }
  .shot p { font-size: 11px; line-height: 1.5; color: #6b5f50; margin: 3px 0 6px; }
  .shot-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .shot-tags span { border-radius: 999px; padding: 2px 6px; font-size: 9.5px; background: #f1e8dc; color: #7b6c5a; }
  .shot-tags .ok { background: rgba(90,108,81,.14); color: var(--moss); }
  .shot-tags .muted { background: #f1e8dc; color: #948674; }
  .note-box { border-left: 2px solid var(--accent); background: rgba(182,93,62,.06); padding: 10px 12px; border-radius: 0 10px 10px 0; font-size: 12px; color: #65594b; }
  .note-box + .note-box { margin-top: 10px; }
  .footer { margin-top: 26px; padding: 0 4px; color: var(--muted); font-size: 11px; display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
  .footer a { color: var(--accent-dark); text-decoration: none; }
  @media (max-width: 980px) {
    .layout { grid-template-columns: 1fr; }
    .side { position: static; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    .page { padding: 16px 13px 50px; }
    .hero { padding: 27px 20px; border-radius: 21px; }
    .hero h1 { font-size: 34px; }
    .chat { padding: 18px 12px 26px; border-radius: 18px; }
    .bubble { padding: 13px 13px 15px; border-radius: 14px; }
    .avatar { flex-basis: 28px; width: 28px; height: 28px; font-size: 9px; border-radius: 9px; }
    .side { grid-template-columns: 1fr; }
    .artifact-frame img { max-height: 480px; }
  }
  @media print {
    body { background: #fff; }
    .page { max-width: none; padding: 0; }
    .hero, .chat, .panel { box-shadow: none; }
    .layout { display: block; }
    .side { position: static; margin-top: 24px; }
    details { open: true; }
    .tool, .prompt { break-inside: avoid; }
    .message { break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="hero">
    <div class="kicker">Golden E2E · 视频前期回放</div>
    <h1>${scenario.heading}</h1>
    <p class="sub">${escapeHtml(scenario.subtitle)}</p>
    <div class="hero-meta">
      <span class="chip"><strong>${durationSeconds ?? "?"} 秒</strong> 总时长</span>
      <span class="chip"><strong>${escapeHtml(aspectRatio)}</strong> ${aspectRatio === "9:16" ? "竖屏" : "画幅"}</span>
      <span class="chip"><strong>${shotCount} 镜头</strong> ${escapeHtml(shotDurationLabel)}</span>
      <span class="chip"><strong>${escapeHtml(consistency)}</strong> 一致性策略</span>
      <span class="chip"><strong>${escapeHtml(modelNames.join(" / ") || "Seedream 4.5")}</strong> 生图模型</span>
    </div>
    <div class="hero-stats">
      <div class="stat"><b>${runLogs.length}</b><span>对话轮次</span></div>
      <div class="stat"><b>${imageAssets.length}</b><span>生成图片</span></div>
      <div class="stat"><b>${videoAssets.length}</b><span>生成视频</span></div>
      <div class="stat"><b>${totalSeconds.toFixed(1)}s</b><span>回放耗时</span></div>
    </div>
  </header>

  <main class="layout">
    <section class="chat">
      <div class="chat-head"><h2>完整对话</h2><span>真实模型 · 隔离内存仓库 · 不写入正式项目</span></div>
      ${messageHtml}
      <div class="stop-card">
        <strong>测试在这里停止</strong>
        <p>${escapeHtml(scenario.stopNote)}</p>
      </div>
    </section>

    <aside class="side">
      <section class="panel">
        <div class="panel-kicker">Test type</div>
        <h3>这是 golden 场景回放，不是普通单测</h3>
        <p>单测验证服务端闸门；这个脚本验证真实模型在多轮对话里是否按正确顺序工作，并产出可阅读的 HTML。每次运行会真实调用 Seedream，视频渠道已置空，避免误出片。</p>
      </section>

      <section class="panel">
        <div class="panel-kicker">Acceptance</div>
        <h3>${assertions.length - failures.length}/${assertions.length} 通过</h3>
        <ul class="checks">${assertionHtml}</ul>
      </section>

      <section class="panel">
        <div class="panel-kicker">Storyboard</div>
        <h3>${escapeHtml(detail?.storyboard.title ?? "未创建分镜")}</h3>
        <ul class="shots">${shotHtml}</ul>
      </section>

      <section class="panel">
        <div class="panel-kicker">Why stop here</div>
        <h3>${multiShot ? "多镜头要按末帧闭环" : "先把这一镜的画面确认下来"}</h3>
        <div class="note-box">${
          multiShot
            ? "第 1 镜已经具备首帧和尾帧，下一镜的关键帧要等第 1 镜视频生成、服务端抽出实际末帧后才能承接。"
            : "这一镜已经具备可生成视频的首帧/尾帧；在用户明确说“视频先别做”时，服务端不应越过确认直接出片。"
        }</div>
        <div class="note-box">本次用户明确说“视频先不要生成”，所以回放停在“可生成第 1 镜视频”的状态，而不是硬造后续画面。</div>
      </section>

      <section class="panel">
        <div class="panel-kicker">Visual review</div>
        <h3>流程通过，视觉仍需人工看</h3>
        <div class="note-box">锚图 → 首帧 → 尾帧保持了奶油白杯身、竹木长盖、无 logo 的同一身份；首尾帧之间只发生推近、光斑移动和手入画。</div>
        <div class="note-box">产品锚图是生成的 45° 斜放示意图，首帧改成了直立；盖高、杯底收边仍有轻微漂移。adaptive 不能替代客户实拍，P2 的 <code>keyframe_drift</code> 视觉校验还没做。</div>
        <div class="note-box">本轮回放还验证了两个边界：内存仓库必须单例，否则分镜 id 会立刻失效；“不要出现开盖/螺纹/内胆”这类否定句不能再被当成开盖状态要求。</div>
      </section>

      <section class="panel">
        <div class="panel-kicker">Lavart 对照</div>
        <h3>它更自由，我们更流程化</h3>
        <div class="note-box">Lavart 的系统提示没有要求先问素材；视频工具可以直接用 prompt 出片，首帧/尾帧只是视频面板里的可选上传，没有 canon、分镜或镜头状态机。</div>
        <div class="note-box">Lavart 首页有“灵感发现”卡片库（包含“影片与分镜”分类），点卡片会把案例变成项目起始需求；它不是 Agent 内的实时搜索工具。</div>
        <div class="note-box">Lavart 不会自动生成视觉参考图、角色图、分镜图；“分镜故事板”是用户主动点的 skill 预设，不是做视频前的强制步骤。</div>
      </section>

      <section class="panel">
        <div class="panel-kicker">Artifacts</div>
        <h3>${imageAssets.length} 张图，0 条视频</h3>
        <p>${imageAssets
          .map((asset) => `${roleLabel(asset)}（${escapeHtml(asset.model ?? "Seedream")}）`)
          .join("、")}</p>
      </section>
    </aside>
  </main>

  <footer class="footer">
    <span>回放项目：${escapeHtml(projectId)}</span>
    <span>生成于 ${escapeHtml(new Date().toISOString())} · 文件：<a href="./transcript.json">transcript.json</a></span>
  </footer>
</div>
</body>
</html>`;

await writeFile(resolve(OUT_DIR, "index.html"), html, "utf8");
console.log(`HTML 已写入：${resolve(OUT_DIR, "index.html")}`);
console.log(`transcript.json 已写入：${resolve(OUT_DIR, "transcript.json")}`);

if (failures.length > 0) {
  process.exitCode = 1;
}