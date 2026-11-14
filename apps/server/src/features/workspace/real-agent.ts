import { randomUUID } from "node:crypto";
import type {
  AspectRatio,
  ChatAttachment,
  ImageBlock,
  RunError,
  RunEvent,
  RunStep,
  VideoBlock,
} from "@my-lovart/shared";
import { fileDataUrlFromUrl, importRemoteFile } from "../files/file.store.js";
import { generateVideoWithMetaso } from "../generation/metaso-video.js";
import {
  GenerationError,
  isAbortError,
  sleep,
  type ImageGenerationResult,
  type VideoGenerationResult,
} from "../generation/types.js";
import { generateImageWithVolces } from "../generation/volces-image.js";

export type RealKind = "auto" | "image" | "video";

export type RealRunInput = {
  runId: string;
  messageId: string;
  text: string;
  kind: RealKind;
  aspectRatio?: AspectRatio;
  attachments: ChatAttachment[];
  signal: AbortSignal;
  baseUrl: string;
};

type Payload<T> = T extends unknown ? Omit<T, "runId" | "messageId" | "seq" | "at"> : never;

const RATIO_LABELS: Record<AspectRatio, string> = {
  "1:1": "方形",
  "4:3": "横版",
  "3:4": "竖版",
  "16:9": "宽屏",
  "9:16": "竖屏",
};

export function looksLikeVideo(text: string): boolean {
  return /视频|短片|分镜|动效|动画|motion|video/i.test(text);
}

export function looksLikeImage(text: string): boolean {
  return /生成|画一|画张|画个|出图|海报|图片|插画|视觉|设计|构图|封面|logo|banner/i.test(text);
}

/**
 * 真实生成运行：事件形状和 mock 完全一致，前端不需要区分模式。
 * 供应商调用在 await 里完成，取消沿用 AbortSignal。
 */
export async function* createRealRun(input: RealRunInput): AsyncGenerator<RunEvent> {
  let seq = 0;
  const emit = (payload: Payload<RunEvent>): RunEvent =>
    ({
      ...payload,
      runId: input.runId,
      messageId: input.messageId,
      seq: seq++,
      at: new Date().toISOString(),
    }) as RunEvent;

  const isVideo = input.kind === "video" || (input.kind === "auto" && looksLikeVideo(input.text));
  const aspect = input.aspectRatio ?? "3:4";
  const references = collectReferences(input.attachments);
  const toolId = randomUUID();

  yield emit({ type: "run.accepted" });
  yield emit({ type: "run.started" });

  const understand: RunStep = {
    id: randomUUID(),
    kind: "understand",
    title: "理解需求",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  yield emit({ type: "step.started", step: understand });

  const thoughtA = randomUUID();
  yield emit({ type: "thinking.started", thoughtId: thoughtA, startedAt: new Date().toISOString() });
  yield emit({
    type: "thinking.delta",
    thoughtId: thoughtA,
    delta: `${RATIO_LABELS[aspect]}构图，${references.length > 0 ? `参考 ${references.length} 张图` : "纯文字描述"}；先把主视觉定下来，再补细节。`,
  });
  yield emit({ type: "thinking.completed", thoughtId: thoughtA });
  await sleep(120, input.signal);

  const summary = videoReply(input.text, aspect);
  for (const chunk of splitReply(summary)) {
    yield emit({ type: "message.delta", delta: chunk });
    await sleep(90, input.signal);
  }

  yield emit({
    type: "step.updated",
    stepId: understand.id,
    status: "done",
    detail: isVideo ? "按短视频处理" : "按单图处理",
  });

  const generate: RunStep = {
    id: randomUUID(),
    kind: "generate",
    title: isVideo ? "渲染视频" : "生成图像",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  yield emit({ type: "step.started", step: generate });

  const thoughtB = randomUUID();
  yield emit({ type: "thinking.started", thoughtId: thoughtB, startedAt: new Date().toISOString() });
  yield emit({
    type: "thinking.delta",
    thoughtId: thoughtB,
    delta: isVideo
      ? "镜头按 8 秒处理：慢起、推进、定格收尾，先把动态预览跑出来。"
      : `Seedream 按 ${aspect} 出图，${references.length > 0 ? "把参考图作为 image 输入" : "只给文字 prompt"}。`,
  });
  yield emit({ type: "thinking.completed", thoughtId: thoughtB });

  yield emit({
    type: "tool.started",
    tool: {
      id: toolId,
      type: "tool",
      tool: isVideo ? "generate_video" : "generate_image",
      status: "running",
      title: isVideo ? "渲染视频" : "生成图像",
      detail: input.text.slice(0, 80),
      stepId: generate.id,
      startedAt: new Date().toISOString(),
      aspectRatio: aspect,
    },
  });

  let artifact: ImageBlock | VideoBlock | undefined;
  let failure: unknown = null;
  let settled = false;
  const queue: RunEvent[] = [];
  const publish = (payload: Payload<RunEvent>) => {
    queue.push(emit(payload));
  };

  const task = (isVideo
    ? runVideo(input, toolId, aspect, references, publish)
    : runImage(input, toolId, aspect, references, publish))
    .then((value) => {
      artifact = value;
    })
    .catch((err) => {
      failure = err;
    })
    .finally(() => {
      settled = true;
    });

  // 供应商调用期间持续把进度事件吐给前端
  while (!settled || queue.length > 0) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (settled) break;
    await sleep(250, input.signal).catch(() => {});
  }
  await task;

  if (!artifact || failure) {
    const err = failure;
    if (isAbortError(err, input.signal)) {
      yield emit({
        type: "tool.failed",
        toolCallId: toolId,
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

    const error: RunError =
      err instanceof GenerationError
        ? { code: err.code, message: err.message, retriable: err.retriable }
        : { code: "internal_error", message: "生成失败，请重试", retriable: true };

    yield emit({ type: "tool.failed", toolCallId: toolId, error });
    yield emit({
      type: "step.updated",
      stepId: generate.id,
      status: "failed",
      detail: error.message,
    });
    yield emit({ type: "run.failed", error });
    return;
  }

  yield emit({ type: "artifact.ready", artifact });

  yield emit({
    type: "tool.completed",
    toolCallId: toolId,
    outputSummary: `${artifact.width} × ${artifact.height} · ${artifact.model}`,
  });
  yield emit({
    type: "step.updated",
    stepId: generate.id,
    status: "done",
    detail: `${artifact.width} × ${artifact.height}`,
  });

  const compose: RunStep = {
    id: randomUUID(),
    kind: "compose",
    title: "放回画布",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  yield emit({ type: "step.started", step: compose });
  await sleep(180, input.signal);
  yield emit({ type: "canvas.sync", artifactId: artifact.id });
  yield emit({
    type: "step.updated",
    stepId: compose.id,
    status: "done",
    detail: "已插入画布",
  });

  yield emit({ type: "run.completed" });
}

async function runImage(
  input: RealRunInput,
  toolId: string,
  aspect: AspectRatio,
  references: string[],
  publish: (payload: Payload<RunEvent>) => void,
): Promise<ImageBlock> {
  publish({ type: "tool.progress", toolCallId: toolId, progress: 15, stage: "提交给 Seedream" });

  const result: ImageGenerationResult = await generateImageWithVolces({
    prompt: buildPrompt(input.text, aspect, false),
    aspectRatio: aspect,
    referenceImages: references,
    signal: input.signal,
  });

  publish({ type: "tool.progress", toolCallId: toolId, progress: 85, stage: "下载结果" });
  const stored = await importRemoteFile(result.url, input.baseUrl, {
    name: input.text.slice(0, 60) || "生成图像",
    fallbackMimeType: result.mimeType,
  }).catch(() => null);

  return {
    type: "image",
    id: randomUUID(),
    url: stored?.url ?? result.url,
    mimeType: stored?.mimeType ?? result.mimeType,
    width: result.width,
    height: result.height,
    prompt: input.text.slice(0, 120),
    model: "Seedream 5.0 Lite",
    aspectRatio: aspect,
    batchId: toolId,
  };
}

async function runVideo(
  input: RealRunInput,
  toolId: string,
  aspect: AspectRatio,
  references: string[],
  publish: (payload: Payload<RunEvent>) => void,
): Promise<VideoBlock> {
  const result: VideoGenerationResult = await generateVideoWithMetaso({
    prompt: buildPrompt(input.text, aspect, true),
    aspectRatio: aspect,
    durationSeconds: 8,
    referenceImages: references,
    signal: input.signal,
    onProgress: (progress, stage) => {
      publish({ type: "tool.progress", toolCallId: toolId, progress, stage });
    },
  });

  const stored = await importRemoteFile(result.url, input.baseUrl, {
    name: input.text.slice(0, 60) || "生成视频",
    fallbackMimeType: result.mimeType,
  }).catch(() => null);

  return {
    type: "video",
    id: randomUUID(),
    url: stored?.url ?? result.url,
    mimeType: stored?.mimeType ?? result.mimeType,
    width: result.width,
    height: result.height,
    durationSeconds: result.durationSeconds,
    prompt: input.text.slice(0, 120),
    model: "MiniMax H3",
    batchId: toolId,
  };
}

function collectReferences(attachments: ChatAttachment[]): string[] {
  const refs: string[] = [];
  for (const attachment of attachments) {
    if (!attachment.mimeType.startsWith("image/")) continue;
    if (attachment.url.startsWith("http") && !attachment.url.includes("/files/")) {
      refs.push(attachment.url);
      continue;
    }
    const dataUrl = fileDataUrlFromUrl(attachment.url);
    if (dataUrl) refs.push(dataUrl);
  }
  return refs.slice(0, 2);
}

function buildPrompt(text: string, aspect: AspectRatio, video: boolean): string {
  const base = text.trim() || (video ? "生成一条有设计感的短片" : "生成一张有设计感的海报");
  return `${base}\n画面比例 ${aspect}。${video ? "镜头稳定，节奏干净。" : "构图完整，留白克制，细节清晰。"}`;
}

function videoReply(text: string, aspect: AspectRatio): string {
  const ratio = RATIO_LABELS[aspect];
  if (looksLikeVideo(text)) {
    return `按 ${ratio}处理，先给你一版 8 秒动态预览：起幅慢、推进稳、结尾定格。镜头和节奏先立住，再逐段调节奏。`;
  }
  return `按 ${ratio}方向出一版：先把主视觉和留白定下来，细节等构图确认后再补。`;
}

function splitReply(text: string): string[] {
  const chunks: string[] = [];
  let buffer = "";
  for (const char of text) {
    buffer += char;
    if (buffer.length >= 8 && /[，。；、！？]/.test(char)) {
      chunks.push(buffer);
      buffer = "";
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}