import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import type { AspectRatio, ImageBlock, VideoBlock } from "@my-lovart/shared";
import { z } from "zod";
import { importRemoteFile } from "../files/file.store.js";
import { generateVideoWithMetaso } from "../generation/metaso-video.js";
import { GenerationError, isAbortError } from "../generation/types.js";
import { generateImageWithVolces } from "../generation/volces-image.js";
import type { AgentEventBus } from "./bus.js";

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

type ToolContext = {
  bus: AgentEventBus;
  attachmentMap: Record<string, string>;
  canvasSummary: string;
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
      async () => JSON.stringify({ canvas: context.canvasSummary }),
      {
        name: "inspect_canvas",
        description: "查看当前画布上有哪些图片、它们的位置和尺寸。规划排版或改图前调用。",
        schema: z.object({}),
      },
    ),
  ];
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