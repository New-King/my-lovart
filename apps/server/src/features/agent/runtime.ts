import type {
  AspectRatio,
  CanvasCommand,
  ChatAttachment,
  ChoiceQuestion,
  ImageBlock,
  InspirationBlock,
  RunError,
  RunEvent,
  ToolName,
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
import { isCheckpointError } from "./persistence/checkpoint-errors.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { createAgentTools } from "./tools.js";



export type AgentRunInput = {
  runId: string;
  messageId: string;
  projectId: string;
  /** 本次 run 开始时间；视频预检用它判断分镜计划是不是刚创建、未经过用户确认 */
  runStartedAt: string;
  text: string;
  kind: "auto" | "image" | "video";
  aspectRatio?: AspectRatio;
  attachments: ChatAttachment[];
  /** 项目产物账本（按时间倒序），跨轮引用图片/视频用 */
  projectAssets: ProjectAsset[];
  history: { role: "user" | "assistant"; content: string }[];
  canvasElements: unknown[];
  canvasFiles: Record<string, unknown>;
  /** 结构化分镜摘要，构建 <project_state> 用 */
  projectStateXml?: string;
  /** 上一轮灵感卡片的编号映射，用户用“第几组第几张”选图时注入 */
  lastInspirationXml?: string;
  baseUrl: string;
  signal: AbortSignal;
  /** LangGraph checkpointer；有它时不再手工拼 history，避免重复 */
  checkpointer?: NonNullable<Parameters<typeof createDeepAgent>[0]>["checkpointer"];
  threadId?: string;
  /** checkpoint 损坏/写不进去时，轮换 thread 并下次用产品历史重建 */
  onCheckpointUnavailable?: (threadId: string) => void | Promise<void>;
  trace?: Trace;
};

type Payload<T> = T extends unknown ? Omit<T, "runId" | "messageId" | "seq" | "at"> : never;

type RawStreamEvent = {
  event: string;
  name?: string;
  run_id?: string;
  data?: Record<string, unknown>;
};

const KNOWN_TOOLS: ToolName[] = [
  "generate_image",
  "generate_video",
  "manipulate_canvas",
  "inspect_canvas",
  "offer_choices",
  "list_assets",
  "get_asset",
  "search_inspiration",
  "list_storyboards",
  "get_storyboard",
  "create_storyboard",
  "update_storyboard",
  "update_shot",
  "reorder_shots",
  "delete_shot",
  "reset_shot",
  "reset_storyboard",
  "restore_storyboard",
  "set_shot_asset",
];

function isKnownTool(name: string): name is ToolName {
  return (KNOWN_TOOLS as string[]).includes(name);
}

function clip(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

type ToolStartMeta = {
  title: string;
  detail?: string;
  inputSummary?: string;
  aspectRatio?: AspectRatio;
};

function toolStartMeta(
  name: string,
  args: Record<string, unknown> | null,
): ToolStartMeta | null {
  const prompt = clip(args?.prompt, 500);
  switch (name) {
    case "generate_image":
    case "generate_video": {
      const aspect = typeof args?.aspectRatio === "string" ? args.aspectRatio : undefined;
      const refs = Array.isArray(args?.referenceImages) ? args.referenceImages.length : 0;
      return {
        title: name === "generate_video" ? "渲染视频" : "生成图像",
        ...(prompt ? { detail: clip(prompt, 90) } : {}),
        ...(prompt || aspect || refs
          ? {
              inputSummary: [
                prompt ? `提示词：${prompt}` : undefined,
                aspect ? `比例：${aspect}` : undefined,
                refs > 0 ? `参考图：${refs} 张` : undefined,
              ]
                .filter(Boolean)
                .join("\n"),
            }
          : {}),
        ...(aspect ? { aspectRatio: aspect as AspectRatio } : {}),
      };
    }
    case "manipulate_canvas": {
      const summary = clip(args?.summary, 200);
      const actions = Array.isArray(args?.actions) ? args.actions.length : 0;
      return {
        title: "调整画布",
        ...(summary ? { detail: clip(summary, 90) } : {}),
        inputSummary: [summary, actions > 0 ? `${actions} 个动作` : undefined]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "offer_choices": {
      const questions = Array.isArray(args?.questions) ? args.questions : [];
      const titles = questions
        .map((item) => (asRecord(item)?.question as string | undefined) ?? "")
        .filter(Boolean);
      return {
        title: "整理问题",
        detail: `${questions.length} 个问题`,
        ...(titles.length > 0 ? { inputSummary: titles.join("\n") } : {}),
      };
    }
    case "search_inspiration": {
      const directions = Array.isArray(args?.directions) ? args.directions : [];
      const labels = directions
        .map((item) => (asRecord(item)?.label as string | undefined) ?? "")
        .filter(Boolean);
      return {
        title: "搜索灵感",
        detail: `${directions.length} 组方向`,
        inputSummary: labels.length > 0 ? labels.join("\n") : undefined,
      };
    }
    case "list_assets": {
      const query = clip(args?.query, 80);
      const kind = clip(args?.kind, 20);
      return {
        title: "查找项目资产",
        detail: query ? `搜索「${query}」` : kind ? `筛选 ${kind}` : "最近资产",
        ...(args
          ? {
              inputSummary: `查询：${query ?? "全部"}${kind ? `\n类型：${kind}` : ""}`,
            }
          : {}),
      };
    }
    case "get_asset":
      return {
        title: "读取资产",
        detail: clip(args?.assetId, 40) ?? "",
        ...(clip(args?.assetId)
          ? { inputSummary: `资产 id：${clip(args?.assetId, 80)}` }
          : {}),
      };
    case "inspect_canvas":
      return {
        title: "查看画布",
        detail: "读取元素与位置",
        inputSummary: "读取当前场景的元素、位置和尺寸",
      };
    case "list_storyboards":
      return {
        title: "查看分镜列表",
        detail: "全部分镜",
        inputSummary: "列出项目里的分镜与镜头数",
      };
    case "get_storyboard": {
      const id = clip(args?.storyboardId, 40);
      return {
        title: "读取分镜",
        detail: id ?? "",
        ...(id ? { inputSummary: `分镜 id：${id}` } : {}),
      };
    }
    case "create_storyboard": {
      const shots = Array.isArray(args?.shots) ? args.shots.length : 0;
      const title = clip(args?.title, 60);
      return {
        title: "创建分镜",
        detail: title ? `${title} · ${shots} 个镜头` : `${shots} 个镜头`,
        inputSummary: [
          title ? `标题：${title}` : undefined,
          clip(args?.brief, 200) ? `brief：${clip(args?.brief, 200)}` : undefined,
          `${shots} 个镜头`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "update_storyboard": {
      const id = clip(args?.storyboardId, 40);
      return {
        title: "更新分镜",
        detail: id ?? "",
        ...(id ? { inputSummary: `分镜 id：${id}` } : {}),
      };
    }
    case "update_shot": {
      const id = clip(args?.shotId, 40);
      const changed = Object.keys(args ?? {}).filter((key) => key !== "shotId");
      return {
        title: "修改镜头",
        detail: id ?? "",
        inputSummary: [id ? `镜头 id：${id}` : undefined, `字段：${changed.join("、")}`]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "reorder_shots": {
      const ids = Array.isArray(args?.shotIds) ? args.shotIds.length : 0;
      const id = clip(args?.storyboardId, 40);
      return {
        title: "调整镜头顺序",
        detail: `${ids} 个镜头`,
        ...(id ? { inputSummary: `分镜 id：${id}\n新顺序：${ids} 个镜头` } : {}),
      };
    }
    case "delete_shot": {
      const id = clip(args?.shotId, 40);
      return {
        title: "删除镜头",
        detail: id ?? "",
        ...(id ? { inputSummary: `镜头 id：${id}` } : {}),
      };
    }
    case "reset_shot": {
      const id = clip(args?.shotId, 40);
      return {
        title: "重置镜头",
        detail: id ?? "",
        ...(id ? { inputSummary: `镜头 id：${id}` } : {}),
      };
    }
    case "reset_storyboard": {
      const id = clip(args?.storyboardId, 40);
      return {
        title: "重置分镜",
        detail: id ?? "",
        ...(id ? { inputSummary: `分镜 id：${id}` } : {}),
      };
    }
    case "restore_storyboard": {
      const revision = clip(args?.revisionId, 40);
      return {
        title: "恢复分镜",
        detail: revision ?? "",
        ...(revision ? { inputSummary: `版本：${revision}` } : {}),
      };
    }
    case "set_shot_asset": {
      const id = clip(args?.shotId, 40);
      const asset = clip(args?.assetId, 40);
      return {
        title: "切换镜头版本",
        detail: id ?? "",
        inputSummary: [id ? `镜头：${id}` : undefined, asset ? `资产：${asset}` : undefined]
          .filter(Boolean)
          .join("\n"),
      };
    }
    default:
      return null;
  }
}

function toolResultSummary(name: string, parsed: Record<string, unknown> | null): string | undefined {
  const summary = clip(parsed?.summary, 300);
  if (summary) return summary;
  if (name === "get_asset") {
    const asset = asRecord(parsed?.asset);
    const title = clip(asset?.title, 80);
    if (title) return `读取「${title}」`;
  }
  if (name === "inspect_canvas") return "已读取画布";
  if (name === "list_storyboards") {
    const count = Array.isArray(parsed?.storyboards) ? parsed.storyboards.length : 0;
    return `${count} 个分镜`;
  }
  if (name === "get_storyboard") {
    const shots = Array.isArray(parsed?.shots) ? parsed.shots.length : 0;
    return `${shots} 个镜头`;
  }
  if (name === "create_storyboard") {
    const shots = Array.isArray(parsed?.shots) ? parsed.shots.length : 0;
    return `已创建 ${shots} 个镜头`;
  }
  if (name === "update_storyboard" || name === "update_shot") return "已更新";
  if (name === "reorder_shots") return "已重排镜头";
  if (name === "delete_shot") return "已删除镜头";
  if (name === "reset_shot") return "已清空镜头当前版本";
  if (name === "reset_storyboard") return "已重置分镜";
  if (name === "restore_storyboard") return "已恢复分镜";
  if (name === "set_shot_asset") return "已切换镜头版本";
  return undefined;
}

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
    runStartedAt: input.runStartedAt,
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
    input.projectStateXml ?? "",
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
  let deliveredArtifact = false;
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
        if (!isKnownTool(name)) continue;

        const toolCallId = event.run_id ?? randomUUID();
        const args = asRecord(event.data?.input);
        const meta = toolStartMeta(name, args);
        if (!meta) continue;

        if (name === "generate_image" || name === "generate_video" || name === "manipulate_canvas") {
          activeTool = { toolCallId };
        }

        yield emit({
          type: "tool.started",
          tool: {
            id: toolCallId,
            type: "tool",
            tool: name,
            status: "running",
            title: meta.title,
            ...(meta.detail ? { detail: meta.detail } : {}),
            ...(meta.inputSummary ? { inputSummary: meta.inputSummary } : {}),
            startedAt: new Date().toISOString(),
            ...(meta.aspectRatio ? { aspectRatio: meta.aspectRatio } : {}),
          },
        });
        continue;
      }

      if (event.event === "on_tool_end") {
        const name = event.name ?? "";
        input.trace?.event("tool.end", { name, output: event.data?.output });
        if (!isKnownTool(name)) continue;
        const toolCallId = event.run_id ?? activeTool?.toolCallId ?? randomUUID();

        if (name === "offer_choices") {
          const parsed = parseToolOutput(event.data?.output);
          const questions = Array.isArray(parsed?.questions)
            ? (parsed.questions as ChoiceQuestion[]).filter(
                (question) =>
                  question &&
                  typeof question.id === "string" &&
                  typeof question.question === "string" &&
                  Array.isArray(question.options) &&
                  question.options.length >= 2,
              )
            : [];
          if (questions.length > 0) {
            yield emit({ type: "message.questions", questions });
          }
          yield emit({
            type: "tool.completed",
            toolCallId,
            outputSummary:
              questions.length > 0 ? `${questions.length} 个问题` : "没有生成问题",
          });
          continue;
        }

        if (name === "manipulate_canvas") {
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

        if (name === "search_inspiration") {
          const parsed = parseToolOutput(event.data?.output);
          if (parsed?.error) {
            yield emit({
              type: "tool.failed",
              toolCallId,
              error: {
                code: typeof parsed.code === "string" ? parsed.code : "inspiration_search_failed",
                message: parsed.error,
                retriable: true,
              },
            });
            continue;
          }
          const artifacts = Array.isArray(parsed?.artifacts) ? parsed.artifacts : [];
          if (artifacts.length > 0) {
            deliveredArtifact = true;
            for (const artifact of artifacts) {
              yield emit({
                type: "artifact.ready",
                artifact: { ...(artifact as object), batchId: toolCallId } as InspirationBlock,
              });
            }
          }
          yield emit({
            type: "tool.completed",
            toolCallId,
            outputSummary:
              toolResultSummary(name, parsed as Record<string, unknown> | null) ??
              `${artifacts.length} 组灵感`,
          });
          continue;
        }

        if (name !== "generate_image" && name !== "generate_video") {
          const parsed = parseToolOutput(event.data?.output);
          if (parsed?.error) {
            yield emit({
              type: "tool.failed",
              toolCallId,
              error: {
                code: typeof parsed.code === "string" ? parsed.code : "tool_error",
                message: parsed.error,
                retriable: true,
              },
            });
          } else {
            yield emit({
              type: "tool.completed",
              toolCallId,
              outputSummary:
                toolResultSummary(name, parsed as Record<string, unknown> | null) ??
                "完成",
            });
          }
          continue;
        }

        activeTool = null;

        const parsed = parseToolOutput(event.data?.output);
        if (parsed?.artifact) {
          const artifact = { ...parsed.artifact, batchId: toolCallId } as ImageBlock | VideoBlock;
          deliveredArtifact = true;
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
        if (!isKnownTool(name)) continue;

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

    const checkpointFailure = checkpointEnabled && isCheckpointError(error);
    if (checkpointFailure) {
      input.trace?.event("checkpoint.write_failed", {
        message: errorMessage(error),
        answerChars: answerText.length,
        deliveredArtifact,
        threadId: input.threadId,
      });
      if (input.threadId) {
        try {
          await input.onCheckpointUnavailable?.(input.threadId);
        } catch (resetError) {
          console.warn(
            "[agent] checkpoint 轮换失败：",
            resetError instanceof Error ? resetError.message : resetError,
          );
        }
      }

      // 图片已经交付、或文字已经回答完，不能因为执行记忆写不进去就报失败。
      // 下一轮没有可用 checkpoint 时会自动用产品消息历史重建。
      if (answerText.trim().length > 0 || deliveredArtifact) {
        yield emit({ type: "run.completed" });
        return;
      }
    }

    const runError: RunError = {
      code: checkpointFailure ? "checkpoint_error" : "agent_error",
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
  projectStateXml: string,
  projectAssetsXml: string,
  hasVision: boolean,
): string {
  const blocks = [input.text || "参考图生成"];
  if (canvasSummary) {
    blocks.push(`<canvas_state>\n${canvasSummary}\n</canvas_state>`);
  }
  if (canvasXml) blocks.push(canvasXml);
  if (projectStateXml) {
    blocks.push(projectStateXml);
    blocks.push(
      "<project_state_note>storyboard_id / shot_id 是稳定 id；改镜头前先用 get_storyboard 确认当前版本，不要凭记忆编 id。</project_state_note>",
    );
  }
  if (projectAssetsXml) {
    blocks.push(projectAssetsXml);
    blocks.push(
      "<project_assets_note>这些是项目里生成过的资产，id 稳定；引用旧图、改图、分镜重做时先用 list_assets/get_asset，不要凭记忆或画布位置猜。</project_assets_note>",
    );
  }
  if (input.lastInspirationXml) {
    blocks.push(input.lastInspirationXml);
    blocks.push(
      "<last_inspiration_note>用户用“第几组第几张”选图时，按这里的编号定位（组=卡片顺序，张=组内顺序），直接用对应 imageUrl 作为 inputImages；不要重新 search_inspiration。</last_inspiration_note>",
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
  | { summary?: string; artifact?: unknown; artifacts?: unknown; error?: string; code?: string; commands?: unknown; options?: unknown; jobId?: string; jobType?: string; questions?: unknown }
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
