import type {
  AspectRatio,
  CanvasCommand,
  ChatAttachment,
  ImageBlock,
  RunError,
  RunEvent,
  VideoBlock,
} from "@my-lovart/shared";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";
import { randomUUID } from "node:crypto";
import { env } from "../../lib/env.js";
import type { Trace } from "../../lib/trace.js";
import type { ProjectAsset } from "../assets/assets.js";
import { AgentEventBus } from "./bus.js";
import { buildAttachmentContext, buildCanvasContext, buildProjectAssetsContext } from "./context.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { createAgentTools } from "./tools.js";



export type AgentRunInput = {
  runId: string;
  messageId: string;
  projectId: string;
  text: string;
  kind: "auto" | "image" | "video";
  aspectRatio?: AspectRatio;
  attachments: ChatAttachment[];
  /** 项目产物账本（按时间倒序），跨轮引用图片/视频用 */
  projectAssets: ProjectAsset[];
  history: { role: "user" | "assistant"; content: string }[];
  canvasElements: unknown[];
  canvasFiles: Record<string, unknown>;
  baseUrl: string;
  signal: AbortSignal;
  /** LangGraph checkpointer；有它时不再手工拼 history，避免重复 */
  checkpointer?: NonNullable<Parameters<typeof createDeepAgent>[0]>["checkpointer"];
  threadId?: string;
  trace?: Trace;
};

type Payload<T> = T extends unknown ? Omit<T, "runId" | "messageId" | "seq" | "at"> : never;

type RawStreamEvent = {
  event: string;
  name?: string;
  run_id?: string;
  data?: Record<string, unknown>;
};

export async function* runAgent(input: AgentRunInput): AsyncGenerator<RunEvent> {
  let seq = 0;
  const emit = (payload: Payload<RunEvent>): RunEvent =>
    ({
      ...payload,
      runId: input.runId,
      messageId: input.messageId,
      seq: seq++,
      at: new Date().toISOString(),
    }) as RunEvent;

  yield emit({ type: "run.accepted" });
  yield emit({ type: "run.started" });

  if (!env.openAiApiKey) {
    yield emit({
      type: "run.failed",
      error: { code: "invalid_config", message: "缺少 OPENAI_API_KEY，Agent 无法运行", retriable: false },
    });
    return;
  }

  const bus = new AgentEventBus();
  const attachmentContext = await buildAttachmentContext(input.attachments);
  const canvasContext = buildCanvasContext(input.canvasElements, input.canvasFiles);
  const projectAssetsContext = buildProjectAssetsContext(input.projectAssets);
  input.trace?.event("agent.context", {
    attachments: attachmentContext.items,
    visionCount: Object.keys(attachmentContext.map).length,
    attachmentXml: attachmentContext.xml,
    canvasElementCount: canvasContext.elements.length,
    canvasSummary: canvasContext.summary,
    canvasXml: canvasContext.xml,
    projectAssetCount: input.projectAssets.length,
    projectAssetXml: projectAssetsContext.xml,
  });
  const tools = createAgentTools({
    bus,
    projectId: input.projectId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    attachmentMap: { ...attachmentContext.map, ...canvasContext.map },
    canvasSummary: canvasContext.summary,
    canvasElements: canvasContext.elements,
    projectAssets: input.projectAssets,
    baseUrl: input.baseUrl,
    signal: input.signal,
  });

  const model = new ChatOpenAI({
    model: env.agentModel,
    apiKey: env.openAiApiKey,
    configuration: { baseURL: env.openAiApiBase },
    streaming: true,
    streamUsage: false,
  });

  const agent = createDeepAgent({
    model,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    name: "mylovart",
    ...(input.checkpointer ? { checkpointer: input.checkpointer } : {}),
  });

  const userText = buildUserText(
    input,
    attachmentContext.xml,
    canvasContext.summary,
    canvasContext.xml,
    projectAssetsContext.xml,
    Object.keys(attachmentContext.map).length > 0,
  );
  const checkpointEnabled = Boolean(input.checkpointer && input.threadId);
  let checkpointHasState = false;
  if (checkpointEnabled && input.checkpointer && input.threadId) {
    try {
      const saver = input.checkpointer as {
        getTuple?: (config: {
          configurable: { thread_id: string };
        }) => Promise<unknown>;
      };
      const tuple = await saver.getTuple?.({
        configurable: { thread_id: input.threadId },
      });
      checkpointHasState = Boolean(tuple);
    } catch (err) {
      input.trace?.event("checkpoint.read_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      checkpointHasState = false;
    }
  }

  const humanMessage = buildHumanMessage(
    userText,
    selectVisionImages(attachmentContext.map, input.trace),
  );
  // 第一次启用 checkpointer 时，把已有的产品历史种进去；之后只发当前消息。
  const messages =
    checkpointEnabled && checkpointHasState
      ? [humanMessage]
      : [
          ...input.history.map((message) =>
            message.role === "assistant"
              ? new AIMessage(message.content)
              : new HumanMessage(message.content),
          ),
          humanMessage,
        ];

  input.trace?.event("model.request", {
    model: env.agentModel,
    checkpointEnabled,
    checkpointHasState,
    threadId: input.threadId,
    historyCount: input.history.length,
    messageCount: messages.length,
    visionCount: Object.keys(attachmentContext.map).length,
    userText,
    messageRoles: input.history.map((message) => message.role),
  });

  let answerText = "";
  let activeTool: { toolCallId: string } | null = null;

  try {
    const stream = agent.streamEvents(
      { messages },
      {
        version: "v2",
        signal: input.signal,
        ...(checkpointEnabled && input.threadId
          ? { configurable: { thread_id: input.threadId } }
          : {}),
      },
    ) as AsyncIterable<RawStreamEvent>;

    for await (const item of mergeWithBus(stream, bus)) {
      if (input.signal.aborted) {
        input.trace?.event("run.canceled", { answer: answerText.slice(-2000) });
        yield emit({ type: "run.canceled" });
        return;
      }

      if (item.source === "bus") {
        if (activeTool) {
          yield emit({
            type: "tool.progress",
            toolCallId: activeTool.toolCallId,
            progress: item.event.progress,
            stage: item.event.stage,
          });
        }
        continue;
      }

      const event = item.event;

      if (event.event === "on_chat_model_stream") {
        const chunk = event.data?.chunk;
        if (!chunk) continue;

        // 推理模型的原始 chain-of-thought 不直接展示给用户；
        // 用户能看到的是模型自己写给用户的计划与结果说明。
        const text = readChunkText(chunk);
        if (text) {
          answerText += text;
          yield emit({ type: "message.delta", delta: text });
        }
        continue;
      }

      if (event.event === "on_tool_start") {
        const name = event.name ?? "";
        input.trace?.event("tool.start", { name, input: event.data?.input });

        if (name === "manipulate_canvas") {
          const toolCallId = event.run_id ?? randomUUID();
          const args = asRecord(event.data?.input);
          activeTool = { toolCallId };
          yield emit({
            type: "tool.started",
            tool: {
              id: toolCallId,
              type: "tool",
              tool: "manipulate_canvas",
              status: "running",
              title: "调整画布",
              detail:
                typeof args?.summary === "string" ? args.summary.slice(0, 100) : undefined,
              startedAt: new Date().toISOString(),
            },
          });
          continue;
        }

        if (name !== "generate_image" && name !== "generate_video") continue;

        const toolCallId = event.run_id ?? randomUUID();
        const args = asRecord(event.data?.input);
        const toolName = name === "generate_video" ? "generate_video" : "generate_image";
        activeTool = { toolCallId };

        yield emit({
          type: "tool.started",
          tool: {
            id: toolCallId,
            type: "tool",
            tool: toolName,
            status: "running",
            title: toolName === "generate_video" ? "渲染视频" : "生成图像",
            detail: typeof args?.prompt === "string" ? args.prompt.slice(0, 100) : undefined,
            startedAt: new Date().toISOString(),
            ...(typeof args?.aspectRatio === "string"
              ? { aspectRatio: args.aspectRatio as AspectRatio }
              : {}),
          },
        });
        continue;
      }

      if (event.event === "on_tool_end") {
        const name = event.name ?? "";
        input.trace?.event("tool.end", { name, output: event.data?.output });

        if (name === "offer_choices") {
          const parsed = parseToolOutput(event.data?.output);
          const options = Array.isArray(parsed?.options)
            ? parsed.options
                .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
                .slice(0, 3)
            : [];
          if (options.length > 0) {
            yield emit({ type: "message.options", options });
          }
          continue;
        }

        if (name === "manipulate_canvas") {
          const toolCallId = event.run_id ?? activeTool?.toolCallId ?? randomUUID();
          activeTool = null;
          const parsed = parseToolOutput(event.data?.output);

          if (parsed?.error) {
            yield emit({
              type: "tool.failed",
              toolCallId,
              error: {
                code: typeof parsed.code === "string" ? parsed.code : "invalid_canvas_command",
                message: parsed.error,
                retriable: true,
              },
            });
            continue;
          }

          const commands = Array.isArray(parsed?.commands)
            ? (parsed.commands as CanvasCommand[])
            : [];
          if (commands.length === 0) {
            yield emit({
              type: "tool.failed",
              toolCallId,
              error: {
                code: "invalid_canvas_command",
                message: "没有可执行的画布动作",
                retriable: true,
              },
            });
            continue;
          }

          yield emit({
            type: "tool.completed",
            toolCallId,
            outputSummary:
              typeof parsed?.summary === "string"
                ? parsed.summary
                : `${commands.length} 个画布操作`,
          });
          yield emit({ type: "canvas.command", commands });
          continue;
        }

        if (name !== "generate_image" && name !== "generate_video") continue;

        const toolCallId = event.run_id ?? activeTool?.toolCallId;
        activeTool = null;
        if (!toolCallId) continue;

        const parsed = parseToolOutput(event.data?.output);
        if (parsed?.artifact) {
          const artifact = { ...parsed.artifact, batchId: toolCallId } as ImageBlock | VideoBlock;
          yield emit({ type: "artifact.ready", artifact });
          yield emit({
            type: "tool.completed",
            toolCallId,
            outputSummary: `${artifact.width} × ${artifact.height} · ${artifact.model}`,
          });
          yield emit({ type: "canvas.sync", artifactId: artifact.id });
        } else if (parsed?.error) {
          yield emit({
            type: "tool.failed",
            toolCallId,
            error: {
              code: typeof parsed.code === "string" ? parsed.code : "provider_error",
              message: parsed.error,
              retriable: true,
              ...(typeof parsed.jobId === "string" ? { jobId: parsed.jobId } : {}),
              ...(parsed.jobType === "image_generation" || parsed.jobType === "video_generation"
                ? { jobType: parsed.jobType }
                : {}),
            },
          });
        } else {
          yield emit({
            type: "tool.completed",
            toolCallId,
            outputSummary: parsed?.summary ?? "完成",
          });
        }
        continue;
      }

      if (event.event === "on_tool_error") {
        const name = event.name ?? "";
        input.trace?.event("tool.error", { name, error: event.data?.error });
        if (
          name !== "generate_image" &&
          name !== "generate_video" &&
          name !== "manipulate_canvas"
        ) {
          continue;
        }

        const toolCallId = event.run_id ?? activeTool?.toolCallId ?? randomUUID();
        activeTool = null;
        yield emit({
          type: "tool.failed",
          toolCallId,
          error: {
            code: "tool_error",
            message: errorMessage(event.data?.error),
            retriable: true,
          },
        });
      }
    }

    if (input.signal.aborted) {
      input.trace?.event("run.canceled", { answer: answerText.slice(-2000) });
      yield emit({ type: "run.canceled" });
      return;
    }

    input.trace?.event("run.completed", { answer: answerText.slice(-4000) });
    yield emit({ type: "run.completed" });
  } catch (error) {
    if (input.signal.aborted) {
      yield emit({ type: "run.canceled" });
      return;
    }

    const runError: RunError = {
      code: "agent_error",
      message: errorMessage(error),
      retriable: true,
    };
    input.trace?.event("run.error", {
      message: runError.message,
      stack: error instanceof Error ? error.stack : undefined,
      answerSoFar: answerText.slice(-2000),
    });
    if (activeTool) {
      yield emit({ type: "tool.failed", toolCallId: activeTool.toolCallId, error: runError });
    }
    yield emit({ type: "run.failed", error: runError });
  }
}

/** LangGraph 流和工具进度队列一起读，保证生图期间也能推进度 */
async function* mergeWithBus(
  stream: AsyncIterable<RawStreamEvent>,
  bus: AgentEventBus,
): AsyncGenerator<{ source: "stream"; event: RawStreamEvent } | { source: "bus"; event: { progress: number; stage: string } }> {
  const iterator = stream[Symbol.asyncIterator]();
  let pending = iterator.next();

  while (true) {
    const busEvent = bus.shift();
    if (busEvent) {
      yield { source: "bus", event: busEvent };
      continue;
    }

    const result = await Promise.race([
      pending.then((value) => ({ type: "stream" as const, value })),
      bus.wait(80).then(() => ({ type: "tick" as const })),
    ]);

    if (result.type === "tick") continue;

    const { value, done } = result.value;
    if (done) break;
    yield { source: "stream", event: value as RawStreamEvent };
    pending = iterator.next();
  }
}

function buildUserText(
  input: AgentRunInput,
  attachmentXml: string,
  canvasSummary: string,
  canvasXml: string,
  projectAssetsXml: string,
  hasVision: boolean,
): string {
  const blocks = [input.text || "参考图生成"];
  if (canvasSummary) {
    blocks.push(`<canvas_state>\n${canvasSummary}\n</canvas_state>`);
  }
  if (canvasXml) blocks.push(canvasXml);
  if (projectAssetsXml) {
    blocks.push(projectAssetsXml);
    blocks.push(
      "<project_assets_note>这些是项目里生成过的资产，id 稳定；引用旧图、改图、分镜重做时先用 list_assets/get_asset，不要凭记忆或画布位置猜。</project_assets_note>",
    );
  }
  if (attachmentXml) {
    blocks.push(attachmentXml);
    blocks.push(
      hasVision
        ? "<vision_note>参考图已经以图片形式附在这条消息里，可以直接看到画面，不要只凭文件名判断。</vision_note>"
        : "<vision_note>用户确实提交了图片附件，但文件没有读取成功（status=\"unavailable\"）。请说明图片打不开、让用户重新上传，不要说「没收到图片」。</vision_note>",
    );
  }
  if (input.kind === "image" || input.kind === "video") {
    blocks.push(`<user_intent>用户这次明确点的是${input.kind === "video" ? "生成视频" : "生成图片"}。</user_intent>`);
  }
  if (input.aspectRatio) blocks.push(`<aspect_ratio>${input.aspectRatio}</aspect_ratio>`);
  return blocks.join("\n\n");
}

/**
 * 参考图不仅写进 XML，还作为视觉内容随消息一起发给模型。
 * 否则模型只看得到文件名，回答「这是谁」「这张图什么风格」时就只能瞎猜。
 * 单张/总量超预算的图不塞给 provider（前端会先缩图，这里是兜底）。
 */
const MAX_VISION_IMAGE_CHARS = 3_500_000; // 约 2.6MB 二进制
const MAX_VISION_TOTAL_CHARS = 9_000_000;

function selectVisionImages(
  attachmentMap: Record<string, string>,
  trace?: Trace,
): string[] {
  const candidates = Object.keys(attachmentMap)
    .sort((a, b) => {
      const left = Number(a.split("-")[1]);
      const right = Number(b.split("-")[1]);
      return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
    })
    .map((key) => attachmentMap[key])
    .filter((url): url is string => Boolean(url));

  const selected: string[] = [];
  let used = 0;
  let skipped = 0;

  for (const url of candidates) {
    if (selected.length >= 4) break;
    const size = url.length;
    if (url.startsWith("data:") && (size > MAX_VISION_IMAGE_CHARS || used + size > MAX_VISION_TOTAL_CHARS)) {
      skipped += 1;
      continue;
    }
    selected.push(url);
    used += size;
  }

  if (skipped > 0) {
    trace?.event("vision.budget", {
      candidates: candidates.length,
      selected: selected.length,
      skipped,
      chars: used,
    });
  }

  return selected;
}

function buildHumanMessage(text: string, images: string[]): HumanMessage {
  if (images.length === 0) return new HumanMessage(text);

  return new HumanMessage({
    content: [
      { type: "text", text },
      ...images.map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
    ],
  });
}

function readChunkText(chunk: unknown): string {
  if (typeof chunk !== "object" || chunk === null) return "";
  const message = chunk as {
    content?: unknown;
    tool_calls?: unknown[];
    tool_call_chunks?: unknown[];
  };

  // 纯工具调用的 chunk 没有正文
  if ((message.tool_calls?.length ?? 0) > 0 || (message.tool_call_chunks?.length ?? 0) > 0) {
    return "";
  }

  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const type = (part as { type?: unknown }).type;
      if (type === "thinking" || type === "reasoning") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function parseToolOutput(output: unknown):
  | { summary?: string; artifact?: unknown; error?: string; code?: string; commands?: unknown; options?: unknown; jobId?: string; jobType?: string }
  | null {
  if (typeof output === "string") return safeJson(output);
  if (typeof output !== "object" || output === null) return null;

  const content = (output as { content?: unknown }).content;
  if (typeof content === "string") return safeJson(content);
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
    if (text) return safeJson(text);
  }

  return null;
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  if (typeof error === "string") return error.slice(0, 300);
  return "Agent 运行失败，请重试";
}
