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
import { chat } from "../../lib/llm.js";

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
  history: { role: "user" | "assistant"; content: string }[];
};

type Payload<T> = T extends unknown ? Omit<T, "runId" | "messageId" | "seq" | "at"> : never;

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

  const plan = await safeChat([
    {
      role: "system",
      content:
        "你是 mylovart 画布里的 AI 设计助手。根据用户这次的需求，用 1-2 句中文写出你打算怎么生成：比例、构图、风格、是否参考图。不要客套，不要说「好的」「没问题」，不要声称已经生成，不要重复用户原话。只输出正文。",
    },
    ...input.history,
    {
      role: "user",
      content: `${input.text || "参考图生成"}\n\n这次生成：${isVideo ? "视频" : "图片"}，比例 ${aspect}${references.length > 0 ? `，有 ${references.length} 张参考图` : "，没有参考图"}。`,
    },
  ]);

  if (plan) {
    const thoughtA = randomUUID();
    yield emit({
      type: "thinking.started",
      thoughtId: thoughtA,
      startedAt: new Date().toISOString(),
    });
    yield emit({ type: "thinking.delta", thoughtId: thoughtA, delta: plan });
    yield emit({ type: "thinking.completed", thoughtId: thoughtA });
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

  const reply = await safeChat([
    {
      role: "system",
      content:
        "你是 mylovart 画布里的 AI 设计助手。生成任务刚刚完成，请用 1-3 句自然的中文回复：说明你生成了什么、画面里你控制的关键点，再给一个具体的下一步建议。不要模板化开头，不要重复用户原话，不要声称看到了模型没给你的细节，只输出正文。",
    },
    ...input.history,
    {
      role: "user",
      content: `${input.text || "参考图生成"}\n\n工具已完成：${artifact.type === "image" ? "生成图片" : "生成视频"}，${artifact.width}×${artifact.height}，模型 ${artifact.model}${artifact.type === "video" ? `，${artifact.durationSeconds} 秒` : ""}。`,
    },
  ]);

  if (reply) {
    for (const chunk of splitReply(reply)) {
      yield emit({ type: "message.delta", delta: chunk });
      await sleep(70, input.signal);
    }
  }

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

async function safeChat(
  messages: Parameters<typeof chat>[0],
): Promise<string> {
  try {
    return (await chat(messages)).trim();
  } catch {
    // 文案生成失败不应该让已经成功的生成任务变成失败
    return "";
  }
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