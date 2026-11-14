import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import type {
  AspectRatio,
  CanvasCommand,
  ImageBlock,
  VideoBlock,
} from "@my-lovart/shared";
import { z } from "zod";
import { importRemoteFile } from "../files/file.store.js";
import { generateVideoWithMetaso } from "../generation/metaso-video.js";
import { GenerationError, isAbortError } from "../generation/types.js";
import { generateImageWithVolces } from "../generation/volces-image.js";
import type { AgentEventBus } from "./bus.js";
import type { CanvasElementBrief } from "./context.js";

const ASPECTS = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const;

const imageSchema = z.object({
  title: z.string().min(1).describe("这张图的短标题，用于消息卡片展示，比如「秋季海报」"),
  prompt: z.string().min(1).describe("完整的生图 prompt，包含主体、构图、配色、光线、风格"),
  aspectRatio: z.enum(ASPECTS).optional().default("3:4").describe("画面比例"),
  inputImages: z
    .array(z.string())
    .optional()
    .describe("参考图的 asset_id（来自 <input_images> 或 <canvas_images>）或公网 URL；做图生图/改图时使用"),
});

const videoSchema = z.object({
  title: z.string().min(1).describe("视频的短标题"),
  prompt: z.string().min(1).describe("完整的视频 prompt，包含主体、镜头运动、节奏、风格"),
  aspectRatio: z.enum(ASPECTS).optional().default("16:9").describe("画面比例"),
  durationSeconds: z.number().int().min(4).max(15).optional().default(8).describe("时长，4-15 秒"),
  inputImages: z
    .array(z.string())
    .optional()
    .describe("首帧/尾帧参考图（最多 2 张），asset_id 或公网 URL"),
});

const canvasId = z
  .string()
  .min(1)
  .describe("画布元素 id，来自 <canvas_state>；也可以直接用 canvas-1 这样的别名");

const canvasIds = z.array(canvasId).min(1).max(60);

const canvasCommandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("move"),
    ids: canvasIds,
    x: z.number().optional().describe("把这一组元素的左上角移到这个 x（组内相对位置不变）"),
    y: z.number().optional(),
    dx: z.number().optional().describe("相对当前位置的横向位移"),
    dy: z.number().optional(),
  }),
  z.object({
    op: z.literal("resize"),
    ids: canvasIds,
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    scale: z.number().min(0.05).max(10).optional().describe("等比缩放倍数"),
  }),
  z.object({ op: z.literal("delete"), ids: canvasIds }),
  z.object({
    op: z.literal("align"),
    ids: canvasIds,
    edge: z
      .enum(["left", "right", "top", "bottom", "centerX", "centerY"])
      .describe("按这一组元素自身的包围盒对齐"),
  }),
  z.object({
    op: z.literal("distribute"),
    ids: canvasIds,
    axis: z.enum(["horizontal", "vertical"]),
  }),
  z.object({
    op: z.literal("reorder"),
    ids: canvasIds,
    to: z.enum(["front", "back"]),
  }),
  z.object({
    op: z.literal("opacity"),
    ids: canvasIds,
    opacity: z.number().min(0).max(100),
  }),
  z.object({ op: z.literal("arrange") }),
]);

const canvasActionSchema = z.object({
  summary: z.string().min(1).describe("一句话说明这次要调整什么"),
  actions: z.array(canvasCommandSchema).min(1).max(8),
});

type ToolContext = {
  bus: AgentEventBus;
  attachmentMap: Record<string, string>;
  canvasSummary: string;
  canvasElements: CanvasElementBrief[];
  baseUrl: string;
  signal: AbortSignal;
};

export function createAgentTools(context: ToolContext) {
  return [
    tool(
      async (input) => {
        context.bus.push({ type: "progress", progress: 12, stage: "提交给 Seedream" });
        try {
          const result = await generateImageWithVolces({
            prompt: input.prompt,
            aspectRatio: input.aspectRatio as AspectRatio,
            referenceImages: resolveReferences(input.inputImages, context.attachmentMap),
            signal: context.signal,
          });

          context.bus.push({ type: "progress", progress: 82, stage: "下载结果" });
          const stored = await importRemoteFile(result.url, context.baseUrl, {
            name: input.title,
            fallbackMimeType: result.mimeType,
          }).catch(() => null);

          const artifact: ImageBlock = {
            type: "image",
            id: randomUUID(),
            url: stored?.url ?? result.url,
            mimeType: stored?.mimeType ?? result.mimeType,
            width: result.width,
            height: result.height,
            prompt: input.prompt.slice(0, 200),
            model: "Seedream 5.0 Lite",
            aspectRatio: input.aspectRatio,
          };

          return JSON.stringify({
            summary: `已生成图片「${input.title}」，${result.width}×${result.height}。`,
            artifact,
          });
        } catch (error) {
          if (isAbortError(error, context.signal)) throw error;
          return errorResult(error);
        }
      },
      {
        name: "generate_image",
        description:
          "生成一张图片。用户要画图、改图、出海报/插画/封面时调用。一次调用只生成一张；需要多个版本时调用多次。",
        schema: imageSchema,
      },
    ),
    tool(
      async (input) => {
        context.bus.push({ type: "progress", progress: 8, stage: "提交任务" });
        try {
          const result = await generateVideoWithMetaso({
            prompt: input.prompt,
            aspectRatio: input.aspectRatio as AspectRatio,
            durationSeconds: input.durationSeconds ?? 8,
            referenceImages: resolveReferences(input.inputImages, context.attachmentMap).slice(0, 2),
            signal: context.signal,
            onProgress: (progress, stage) =>
              context.bus.push({ type: "progress", progress, stage }),
          });

          const stored = await importRemoteFile(result.url, context.baseUrl, {
            name: input.title,
            fallbackMimeType: result.mimeType,
          }).catch(() => null);

          const artifact: VideoBlock = {
            type: "video",
            id: randomUUID(),
            url: stored?.url ?? result.url,
            mimeType: stored?.mimeType ?? result.mimeType,
            width: result.width,
            height: result.height,
            durationSeconds: result.durationSeconds,
            prompt: input.prompt.slice(0, 200),
            model: "MiniMax H3",
          };

          return JSON.stringify({
            summary: `已生成视频「${input.title}」，${result.durationSeconds} 秒。`,
            artifact,
          });
        } catch (error) {
          if (isAbortError(error, context.signal)) throw error;
          return errorResult(error);
        }
      },
      {
        name: "generate_video",
        description:
          "生成一条短视频。用户明确要视频、短片、动效时调用。支持首帧/尾帧参考图，最多 2 张。",
        schema: videoSchema,
      },
    ),
    tool(
      async (input) => {
        const resolved = resolveCanvasCommands(input.actions, context.canvasElements);
        if ("error" in resolved) {
          return JSON.stringify({ error: resolved.error, code: "invalid_canvas_command" });
        }
        return JSON.stringify({ summary: input.summary, commands: resolved.commands });
      },
      {
        name: "manipulate_canvas",
        description:
          "调整画布上已有的元素：移动、缩放、删除、对齐、均匀分布、调整前后层、改透明度，或整理全部图片。先用 inspect_canvas 或 <canvas_state> 拿到元素 id / 别名，不要编造。一次可以提交 1-8 个动作，按数组顺序执行；返回的命令由前端真正应用。",
        schema: canvasActionSchema,
      },
    ),
    tool(
      async () => JSON.stringify({ canvas: context.canvasSummary }),
      {
        name: "inspect_canvas",
        description: "查看当前画布上有哪些元素、它们的位置和尺寸。规划排版或改图前调用。",
        schema: z.object({}),
      },
    ),
  ];
}

type CanvasActionInput = z.infer<typeof canvasCommandSchema>;

/** 把 canvas-N 别名换成真实 element id，并在执行前做语义校验 */
function resolveCanvasCommands(
  actions: CanvasActionInput[],
  elements: CanvasElementBrief[],
): { commands: CanvasCommand[] } | { error: string } {
  const byAlias = new Map(elements.map((element) => [element.alias, element.id]));
  const known = new Set(elements.map((element) => element.id));
  const available = elements
    .slice(0, 12)
    .map((element) => `${element.alias}=「${element.name}」`)
    .join("，");
  const commands: CanvasCommand[] = [];

  for (const action of actions) {
    if (action.op === "arrange") {
      commands.push({ op: "arrange" });
      continue;
    }

    const ids: string[] = [];
    for (const raw of action.ids) {
      const resolved = byAlias.get(raw) ?? (known.has(raw) ? raw : undefined);
      if (!resolved) {
        return {
          error: `找不到画布元素「${raw}」。当前可用：${available || "（空画布）"}。请先调用 inspect_canvas。`,
        };
      }
      if (!ids.includes(resolved)) ids.push(resolved);
    }

    switch (action.op) {
      case "move":
        if (
          action.x === undefined &&
          action.y === undefined &&
          action.dx === undefined &&
          action.dy === undefined
        ) {
          return { error: "move 需要 x/y（绝对位置）或 dx/dy（相对位移）至少一个" };
        }
        if (
          (action.x !== undefined || action.y !== undefined) &&
          (action.dx !== undefined || action.dy !== undefined)
        ) {
          return { error: "move 不能同时用绝对位置 x/y 和相对位移 dx/dy，选一种" };
        }
        commands.push({
          op: "move",
          ids,
          ...(action.x !== undefined ? { x: action.x } : {}),
          ...(action.y !== undefined ? { y: action.y } : {}),
          ...(action.dx !== undefined ? { dx: action.dx } : {}),
          ...(action.dy !== undefined ? { dy: action.dy } : {}),
        });
        break;

      case "resize":
        if (
          action.width === undefined &&
          action.height === undefined &&
          action.scale === undefined
        ) {
          return { error: "resize 需要 width、height 或 scale 至少一个" };
        }
        if (
          action.scale !== undefined &&
          (action.width !== undefined || action.height !== undefined)
        ) {
          return { error: "resize 的 scale 不能和 width/height 同时使用" };
        }
        commands.push({
          op: "resize",
          ids,
          ...(action.width !== undefined ? { width: action.width } : {}),
          ...(action.height !== undefined ? { height: action.height } : {}),
          ...(action.scale !== undefined ? { scale: action.scale } : {}),
        });
        break;

      case "delete":
        commands.push({ op: "delete", ids });
        break;

      case "align":
        if (ids.length < 2) return { error: "align 至少需要两个元素" };
        commands.push({ op: "align", ids, edge: action.edge });
        break;

      case "distribute":
        if (ids.length < 3) return { error: "distribute 至少需要三个元素" };
        commands.push({ op: "distribute", ids, axis: action.axis });
        break;

      case "reorder":
        commands.push({ op: "reorder", ids, to: action.to });
        break;

      case "opacity":
        commands.push({ op: "opacity", ids, opacity: action.opacity });
        break;
    }
  }

  return { commands };
}

function resolveReferences(
  input: string[] | undefined,
  attachmentMap: Record<string, string>,
): string[] {
  if (!input?.length) return [];
  return input
    .map((item) =>
      item.startsWith("asset-")
        ? attachmentMap[item]
        : item.startsWith("http") || item.startsWith("data:")
          ? item
          : attachmentMap[item],
    )
    .filter((item): item is string => Boolean(item));
}

function errorResult(error: unknown): string {
  const message =
    error instanceof GenerationError ? error.message : "生成失败，供应商没有返回结果";
  const code = error instanceof GenerationError ? error.code : "provider_error";
  return JSON.stringify({ error: message, code });
}