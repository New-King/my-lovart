import { randomUUID } from "node:crypto";
import type {
  AspectRatio,
  Artifact,
  ChatAttachment,
  InspirationItem,
  RunError,
  RunEvent,
  RunStep,
  StepKind,
  ToolBlock,
  ToolName,
} from "@my-lovart/shared";
import { env } from "../../lib/env.js";

const assetBase = env.webOrigins[0] ?? "http://localhost:3000";
const asset = (path: string) => `${assetBase}${path}`;

const MOCK_VIDEO_URL =
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";

const POSTERS = ["poster-1", "poster-2", "poster-3", "poster-4"].map((name) =>
  asset(`/mock/${name}.svg`),
);

const INSPIRATIONS = ["insp-1", "insp-2", "insp-3", "insp-4"].map((name, index) => ({
  name,
  url: asset(`/mock/${name}.svg`),
  title: ["编辑感留白", "网格与秩序", "大字排版", "空间与层次"][index] ?? "参考",
}));

/** 失败注入只对同一句生效一次，方便验证「重试后成功」 */
const failedOnce = new Set<string>();

export type MockKind = "auto" | "image" | "video";

export type MockRunInput = {
  runId: string;
  messageId: string;
  projectId: string;
  text: string;
  kind: MockKind;
  aspectRatio?: AspectRatio;
  attachments: ChatAttachment[];
  signal: AbortSignal;
};

type Payload<T> = T extends unknown ? Omit<T, "runId" | "messageId" | "seq" | "at"> : never;

const RATIOS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "4:3": { width: 1280, height: 960 },
  "3:4": { width: 960, height: 1280 },
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish);
  });
}

/** 按标点切块，模拟逐段吐字，长度不均看起来更自然。 */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let buffer = "";
  for (const char of text) {
    buffer += char;
    if (buffer.length >= 7 && /[，。；、！？：\n]/.test(char)) {
      chunks.push(buffer);
      buffer = "";
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

function hashOf(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 97_999;
  }
  return hash;
}

function pickKind(input: MockRunInput): "image" | "video" | "inspiration" {
  if (input.kind === "image" || input.kind === "video") return input.kind;
  if (/视频|短片|分镜|动效|motion|video/i.test(input.text)) return "video";
  if (
    input.attachments.length === 0 &&
    /灵感|参考|案例|配色|inspiration|reference/i.test(input.text)
  ) {
    return "inspiration";
  }
  return "image";
}

function textForImage(input: MockRunInput): string {
  if (input.attachments.length > 0) {
    return `我看了你给的 ${input.attachments.length} 张参考图，主要特征是低饱和、留白多、标题压在下方。先按这个方向出一版竖构图，主色 #1D1D1F，底色 #F5F5F7。`;
  }
  return "先按竖版方向给你一版：大留白、单色主视觉、标题压在下三分之一。构图先立住，再决定要不要加细节。";
}

function textForVideo(): string {
  return "分镜按 15 秒、6 个镜头处理：慢起、快切、定格收尾。先给你一版动态预览，后面可以逐镜头调节奏。";
}

function textForInspiration(): string {
  return "找了几张同类方向的参考：构图偏中心、低饱和、文字少。可以挑一张作为整体基调，我再按它出一版。";
}

function thoughtFor(
  kind: "image" | "video" | "inspiration",
  input: MockRunInput,
  phase: "understand" | "plan",
): string {
  if (phase === "understand") {
    if (kind === "inspiration") {
      return "用户要的是方向，不是成品；先按低饱和、编辑感、少文字筛参考。";
    }
    if (input.attachments.length > 0) {
      return "参考图里能复用的信息是配色和留白比例，构图需要重做，避免直接拼贴。";
    }
    return "先把主体和主色定下来，再补细节；比例按用户选的来。";
  }

  if (kind === "video") {
    return "节奏按 15 秒、6 个镜头走，慢起快切，最后一个镜头定格。";
  }
  if (kind === "inspiration") {
    return "四张参考已经够覆盖方向，收回来的结果按构图相似度排序。";
  }
  return "中心构图更稳，标题压在下三分之一，留白比例大约 3:2。";
}

/**
 * 假生成器，但事件形状和真实任务一致：
 * accepted → started → step（理解/规划/生成/落画布）→ tool（排队/进度）→ artifact → completed。
 * 用户中途停止（signal.aborted）时以 run.canceled 收尾，已产出的内容保留。
 */
export async function* createMockRun(input: MockRunInput): AsyncGenerator<RunEvent> {
  const { runId, messageId, signal } = input;
  let seq = 0;
  const emit = (payload: Payload<RunEvent>): RunEvent =>
    ({
      ...payload,
      runId,
      messageId,
      seq: seq++,
      at: new Date().toISOString(),
    }) as RunEvent;

  const step = (kind: StepKind, title: string, detail?: string): RunStep => ({
    id: randomUUID(),
    kind,
    title,
    status: "running",
    startedAt: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  });

  const mode = pickKind(input);
  const isVideo = mode === "video";
  const ratio: AspectRatio = input.aspectRatio ?? (isVideo ? "16:9" : "3:4");
  const size = RATIOS[ratio] ?? RATIOS["3:4"];
  const model = isVideo ? "mock-video" : mode === "inspiration" ? "mock-search" : "mock-image";

  yield emit({ type: "run.accepted", queuePosition: 0 });
  await sleep(260, signal);
  if (signal.aborted) {
    yield emit({ type: "run.canceled" });
    return;
  }
  yield emit({ type: "run.started" });

  // 1. 理解需求
  const understand = step(
    "understand",
    "理解需求",
    input.attachments.length > 0 ? `参考图 ${input.attachments.length} 张` : undefined,
  );
  yield emit({ type: "step.started", step: understand });

  const firstThoughtId = randomUUID();
  yield emit({
    type: "thinking.started",
    thoughtId: firstThoughtId,
    startedAt: new Date().toISOString(),
  });
  for (const chunk of chunkText(thoughtFor(mode, input, "understand"))) {
    if (signal.aborted) break;
    yield emit({ type: "thinking.delta", thoughtId: firstThoughtId, delta: chunk });
    await sleep(35, signal);
  }
  yield emit({ type: "thinking.completed", thoughtId: firstThoughtId });
  await sleep(140, signal);
  if (signal.aborted) {
    yield emit({ type: "step.updated", stepId: understand.id, status: "failed", detail: "已停止" });
    yield emit({ type: "run.canceled" });
    return;
  }
  yield emit({
    type: "step.updated",
    stepId: understand.id,
    status: "done",
    detail: input.attachments.length > 0 ? "已提取配色与留白" : "已确认主体与风格",
  });

  // 2. 规划画面
  const plan = step(
    "plan",
    mode === "inspiration" ? "确定检索方向" : isVideo ? "拆分镜" : "规划构图",
    undefined,
  );
  yield emit({ type: "step.started", step: plan });

  const secondThoughtId = randomUUID();
  yield emit({
    type: "thinking.started",
    thoughtId: secondThoughtId,
    startedAt: new Date().toISOString(),
  });
  for (const chunk of chunkText(thoughtFor(mode, input, "plan"))) {
    if (signal.aborted) break;
    yield emit({ type: "thinking.delta", thoughtId: secondThoughtId, delta: chunk });
    await sleep(38, signal);
  }
  yield emit({ type: "thinking.completed", thoughtId: secondThoughtId });

  await sleep(isVideo ? 480 : 360, signal);
  if (signal.aborted) {
    yield emit({ type: "step.updated", stepId: plan.id, status: "failed", detail: "已停止" });
    yield emit({ type: "run.canceled" });
    return;
  }
  yield emit({
    type: "step.updated",
    stepId: plan.id,
    status: "done",
    detail:
      mode === "inspiration"
        ? "低饱和 · 编辑感 · 少文字"
        : isVideo
          ? `6 个镜头 · ${ratio} · 15s`
          : `${ratio} · #1D1D1F / #F5F5F7`,
  });

  // 先把方向说清楚，再开始生成，和真实 Agent 的节奏一致
  const text =
    mode === "inspiration"
      ? textForInspiration()
      : isVideo
        ? textForVideo()
        : textForImage(input);
  for (const chunk of chunkText(text)) {
    if (signal.aborted) {
      yield emit({ type: "run.canceled" });
      return;
    }
    yield emit({ type: "message.delta", delta: chunk });
    await sleep(42, signal);
  }

  // 3. 生成
  const generate = step(
    "generate",
    mode === "inspiration" ? "搜索参考" : isVideo ? "渲染视频" : "生成图像",
    `${size.width} × ${size.height}`,
  );
  yield emit({ type: "step.started", step: generate });

  const toolName: ToolName =
    mode === "inspiration" ? "search_inspiration" : isVideo ? "generate_video" : "generate_image";
  const tool: ToolBlock = {
    type: "tool",
    id: randomUUID(),
    tool: toolName,
    status: "queued",
    title: mode === "inspiration" ? "搜索灵感" : isVideo ? "生成视频" : "生成图像",
    detail: `${size.width} × ${size.height} · ${ratio} · ${model}`,
    stepId: generate.id,
    startedAt: new Date().toISOString(),
    aspectRatio: ratio,
    progress: 0,
    stage: "排队中",
  };
  yield emit({ type: "tool.started", tool });
  await sleep(420, signal);

  const stages =
    mode === "inspiration"
      ? ["检索中", "去重", "排序"]
      : isVideo
        ? ["排队中", "解析分镜", "渲染关键帧", "插帧", "编码", "封装"]
        : ["排队中", "解析提示词", "扩散", "补细节", "压缩"];

  // 演示用失败注入：第一次带「模拟失败」或 /fail 会失败，重试同一句则成功
  const shouldFail =
    /模拟失败|\/fail\b/i.test(input.text) && !failedOnce.has(input.text);

  for (const [index, stage] of stages.entries()) {
    if (signal.aborted) break;
    const progress = Math.round(((index + 1) / stages.length) * (shouldFail ? 55 : 95));
    yield emit({
      type: "tool.progress",
      toolCallId: tool.id,
      progress,
      stage,
    });
    await sleep(isVideo ? 520 : mode === "inspiration" ? 280 : 380, signal);
  }

  if (signal.aborted) {
    yield emit({
      type: "tool.failed",
      toolCallId: tool.id,
      error: { code: "aborted", message: "已停止生成", retriable: true },
    });
    yield emit({
      type: "step.updated",
      stepId: generate.id,
      status: "failed",
      detail: "已停止",
    });
    yield emit({ type: "run.canceled" });
    return;
  }

  if (shouldFail) {
    failedOnce.add(input.text);
    const error: RunError = {
      code: "provider_timeout",
      message: "生成服务超时，超过 60 秒没有返回结果。",
      retriable: true,
    };
    yield emit({ type: "tool.failed", toolCallId: tool.id, error });
    yield emit({
      type: "step.updated",
      stepId: generate.id,
      status: "failed",
      detail: error.message,
    });
    yield emit({ type: "run.failed", error });
    return;
  }

  const artifact: Artifact =
    mode === "inspiration"
      ? {
          type: "inspiration",
          id: randomUUID(),
          query: "低饱和 · 编辑感 · 海报排版",
          items: INSPIRATIONS.map<InspirationItem>((item) => ({
            id: randomUUID(),
            title: item.title,
            imageUrl: item.url,
            source: "Mock Gallery",
            width: 800,
            height: 600,
          })),
        }
      : isVideo
        ? {
            type: "video",
            id: randomUUID(),
            url: MOCK_VIDEO_URL,
            posterUrl: asset("/mock/video-poster.svg"),
            mimeType: "video/mp4",
            width: size.width,
            height: size.height,
            durationSeconds: 15,
            prompt: input.text.slice(0, 80) || "生成视频",
            model,
          }
        : (() => {
            const poster = POSTERS[hashOf(input.text) % POSTERS.length] ?? POSTERS[0]!;
            return {
              type: "image" as const,
              id: randomUUID(),
              url: poster,
              mimeType: "image/svg+xml",
              width: size.width,
              height: size.height,
              prompt: input.text.slice(0, 80) || "生成图像",
              model,
              aspectRatio: ratio,
            };
          })();

  yield emit({ type: "artifact.ready", artifact });
  yield emit({
    type: "tool.completed",
    toolCallId: tool.id,
    outputSummary: `${size.width} × ${size.height} · ${model}`,
  });
  yield emit({
    type: "step.updated",
    stepId: generate.id,
    status: "done",
    detail: `${size.width} × ${size.height} · ${model}`,
  });

  // 4. 落回画布
  const compose = step("compose", "放回画布", undefined);
  yield emit({ type: "step.started", step: compose });
  await sleep(240, signal);
  yield emit({ type: "canvas.sync", artifactId: artifact.id });
  yield emit({
    type: "step.updated",
    stepId: compose.id,
    status: "done",
    detail: mode === "inspiration" ? "参考已就绪" : "已插入画布中心",
  });

  // 收尾
  yield emit({ type: "run.completed" });
}