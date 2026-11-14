import type {
  AspectRatio,
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
import { AgentEventBus } from "./bus.js";
import { buildAttachmentContext, buildCanvasContext } from "./context.js";
import { createAgentTools } from "./tools.js";

const SYSTEM_PROMPT = `你是 mylovart 的 AI 设计助手，工作在一个无限画布工具里。

行为要求：
- 所有内部思考、计划和回复都必须用中文。
- 用中文，简洁、具体，不要客套话和总结段落。

先对齐，再生成：
- 只有需求足够具体时才调用生成工具。图片至少需要：主体、用途或比例、风格/参考图；视频至少需要：主体、时长或平台（横/竖）、画面基调或脚本方向。
- 信息不够时，先用 1-2 句给出你的默认方案，再问最多 3 个关键问题，然后结束这一轮，不要调用任何工具，不要先做首帧图。
- 用户说「先出一版」「直接做」「不用问」或已经给全信息时，直接开工，不要再确认。
- 不要用工具来提问；问题直接写在回复里。用户回答后直接执行，不要重复确认。

生成与工具：
- 用户要生成图片或视频时，必须调用 \`generate_image\` / \`generate_video\`，不要只描述画面，也不要假装已经生成。
- 生成前先用 1-2 句说明你打算怎么做（比例、构图、风格、是否用参考图）；生成后用 1-3 句说明结果和下一步建议。不要套固定开头，不要重复用户原话。
- 一次工具调用只产出一张图或一条视频；用户要多版本时分多次调用，并在 title 上区分。
- 有参考图时，用 <input_images> 或 <canvas_images> 里的 asset_id 传给工具的 inputImages；不要凭空编造图片内容。
- 需要了解画布现状时调用 \`inspect_canvas\`，不要猜测坐标。
- 不要编造工具没有返回的信息；工具报错就如实说明并给替代方案。`;

export type AgentRunInput = {
  runId: string;
  messageId: string;
  text: string;
  kind: "auto" | "image" | "video";
  aspectRatio?: AspectRatio;
  attachments: ChatAttachment[];
  history: { role: "user" | "assistant"; content: string }[];
  canvasElements: unknown[];
  canvasFiles: Record<string, unknown>;
  baseUrl: string;
  signal: AbortSignal;
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
  const attachmentContext = buildAttachmentContext(input.attachments);
  const canvasContext = buildCanvasContext(input.canvasElements, input.canvasFiles);
  const tools = createAgentTools({
    bus,
    attachmentMap: { ...attachmentContext.map, ...canvasContext.map },
    canvasSummary: canvasContext.summary,
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
  });

  const userText = buildUserText(
    input,
    attachmentContext.xml,
    canvasContext.summary,
    canvasContext.xml,
  );
  const messages = [
    ...input.history.map((message) =>
      message.role === "assistant" ? new AIMessage(message.content) : new HumanMessage(message.content),
    ),
    new HumanMessage(userText),
  ];

  let activeTool: { toolCallId: string } | null = null;

  try {
    const stream = agent.streamEvents(
      { messages },
      { version: "v2", signal: input.signal },
    ) as AsyncIterable<RawStreamEvent>;

    for await (const item of mergeWithBus(stream, bus)) {
      if (input.signal.aborted) {
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
        if (text) yield emit({ type: "message.delta", delta: text });
        continue;
      }

      if (event.event === "on_tool_start") {
        const name = event.name ?? "";
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
        if (name !== "generate_image" && name !== "generate_video") continue;

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
      yield emit({ type: "run.canceled" });
      return;
    }
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
): string {
  const blocks = [input.text || "参考图生成", `<canvas_state>\n${canvasSummary}\n</canvas_state>`];
  if (canvasXml) blocks.push(canvasXml);
  if (attachmentXml) blocks.push(attachmentXml);
  if (input.kind === "image" || input.kind === "video") {
    blocks.push(`<user_intent>用户这次明确点的是${input.kind === "video" ? "生成视频" : "生成图片"}。</user_intent>`);
  }
  if (input.aspectRatio) blocks.push(`<aspect_ratio>${input.aspectRatio}</aspect_ratio>`);
  return blocks.join("\n\n");
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
  | { summary?: string; artifact?: unknown; error?: string; code?: string }
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