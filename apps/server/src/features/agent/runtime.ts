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
import { AgentEventBus } from "./bus.js";
import { buildAttachmentContext, buildCanvasContext } from "./context.js";
import { createAgentTools } from "./tools.js";

const SYSTEM_PROMPT = `你是 mylovart 的 AI 设计助手，工作在一个无限画布工具里。

行为要求：
- 所有内部思考、计划和回复都必须用中文。
- 用中文，简洁、具体，不要客套话和总结段落。

事实来源：
- <input_images> 是用户在本轮或前几轮发过的参考图。它不属于画布，但一直可用；要图生图或改图时直接用它的 asset_id。
- <canvas_state> 和 <canvas_images> 描述画布上现有的元素。画布为空时明确说画布是空的，但不要把 <input_images> 里的参考图也说成不存在。
- 不要根据历史对话假设画布上还有图，也不要编造用户上传了素材。
- 不确定画布上有什么时，先调用 \`inspect_canvas\`，不要猜。

先判断信息够不够：
- 图片至少需要：主体、用途或比例、风格/参考图。
- 视频至少需要：主体、用途/平台（横/竖）、时长、画面基调或脚本方向。
- 用户说「先出一版」「直接做」「不用问」或已经给全信息时，直接开工，不要再确认。

信息很少时（缺两个或以上关键项，或只有一句模糊目标）：
- 不要出按钮，也不要用生成工具。用紧凑的 Markdown 清单问 2-3 个最关键的问题，问完就停。
- 每个问题写清楚这个答案会影响什么（平台、画幅、时长、节奏、风格），让用户可以按序号一次回答。
- 画布为空时先说明这一点，不要引用不存在的图片或上传进度。

只差一个关键项时（用户已经给出大部分信息）：
- 用一句承接 + 一句问题把缺的那项问出来；按钮轮正文最多 2 句，不要先讲一堆分析。
- 如果这个问题有 1-3 个清晰、互斥的候选答案，先问，再调用 \`offer_choices\` 把候选答案交给用户点选，然后停止这一轮。
- 选项必须是这个问题的答案（例如「16:9 横版」「9:16 竖版」「1:1 方版」），不能写「已经传好了」「刷新看看」「先占位」这类寒暄、确认或下一步动作。
- 开放性问题（卖点、故事、文案）不要出按钮；素材缺失（logo、产品图）只请用户上传，不要出按钮。
- 用户回答后直接推进，不要重复确认。

生成之后：
- 不要用 \`offer_choices\` 给下一步建议；最多用一句话说明可以怎么改，把决定权交给用户。

工作方式：
- 先判断交付物和用途，再决定构图、风格和比例；不要一上来就堆砌形容词。
- 用户没有指定风格时，给一个明确的设计方向并说明理由，不要列出五种风格让用户选。
- 产物已经在画布或回复里时，用几句话收尾并停止调用工具；不要为了多做一版继续生成，除非用户要求。
- 用户要改图时，优先用已有图片作为 inputImages 做图生图，而不是从零重画。

生成与工具：
- 用户要生成图片或视频时，必须调用 \`generate_image\` / \`generate_video\`，不要只描述画面，也不要假装已经生成。
- 生成前先用 1-2 句说明你打算怎么做（比例、构图、风格、是否用参考图）；生成后用 1-3 句说明结果和下一步建议。不要套固定开头，不要重复用户原话。
- 一次工具调用只产出一张图或一条视频；用户要多版本时分多次调用，并在 title 上区分。
- 有参考图时，用 <input_images> 或 <canvas_images> 里的 asset_id 传给工具的 inputImages；不要凭空编造图片内容。
- 需要了解画布现状时调用 \`inspect_canvas\`，不要猜测坐标。
- 画布上的移动、缩放、删除、对齐、均匀分布、前后层、透明度、整体整理，用 \`manipulate_canvas\`；元素 id 或 canvas-N 别名必须来自 <canvas_state>，不能编造。用户说「并排」「对齐」「整理一下」「删掉这张」「放大一点」时直接操作，不要重新生成图片。
- 改完画布用一句话说明动了什么；不要假装已经移动，工具返回成功才代表前端会执行。
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
    canvasElements: canvasContext.elements,
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
  | { summary?: string; artifact?: unknown; error?: string; code?: string; commands?: unknown; options?: unknown }
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
