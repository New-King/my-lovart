import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import type {
  AspectRatio,
  CanvasCommand,
  ImageBlock,
  VideoBlock,
} from "@my-lovart/shared";
import { z } from "zod";
import type { ProjectAsset } from "../assets/assets.js";
import { fileDataUrlFromUrl, importRemoteFile } from "../files/file.store.js";
import { generateVideoWithMetaso } from "../generation/metaso-video.js";
import { GenerationError, isAbortError } from "../generation/types.js";
import { generateImageWithVolces } from "../generation/volces-image.js";
import { createJob, cancelJob, jobsEnabled, waitForJob } from "../jobs/jobs.js";
import { getAssetsRepository } from "../assets/assets.repository.js";
import { getStoryboardsRepository } from "../storyboards/storyboards.repository.js";
import { activeShots } from "../storyboards/storyboards.js";
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
  shotId: z
    .string()
    .min(1)
    .optional()
    .describe("要挂到的分镜镜头 id；生成成功后自动成为该镜头当前版本"),
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
  shotId: z
    .string()
    .min(1)
    .optional()
    .describe("要挂到的分镜镜头 id；生成成功后自动成为该镜头当前版本"),
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

const choicesSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z
          .string()
          .min(1)
          .max(120)
          .describe("一个需要用户确认的关键问题"),
        options: z
          .array(z.string().min(1).max(60))
          .min(2)
          .max(4)
          .describe("2-4 个互斥的候选答案；不要写下一步动作"),
      }),
    )
    .min(1)
    .max(3)
    .describe("1-3 个关键问题；用户逐个选择或自定义回答"),
});

const listAssetsSchema = z.object({
  query: z.string().optional().describe("按标题、prompt、模型或分镜 id 模糊搜索"),
  kind: z.enum(["image", "video"]).optional(),
  limit: z.number().int().min(1).max(20).optional().default(10),
});

const getAssetSchema = z.object({
  assetId: z.string().min(1).describe("资产 id，来自 <project_assets> 或 list_assets 结果"),
});

const storyboardIdSchema = z.string().min(1).describe("分镜 id，来自 <project_state> 或 list_storyboards");

const getStoryboardSchema = z.object({
  storyboardId: storyboardIdSchema,
});

const shotInputSchema = z.object({
  title: z.string().min(1).max(80).describe("镜头短标题"),
  description: z.string().max(600).optional().describe("画面描述"),
  prompt: z.string().max(2000).optional().describe("生图/生视频 prompt 草稿"),
  durationSeconds: z.number().min(1).max(15).optional(),
  camera: z.string().max(80).optional().describe("机位/运动，如 俯拍、推镜"),
  transition: z.string().max(80).optional().describe("转场，如 叠化、切"),
});

const createStoryboardSchema = z.object({
  title: z.string().min(1).max(80),
  brief: z.string().min(1).max(1000).describe("分镜目标/用途"),
  aspectRatio: z.enum(ASPECTS).optional(),
  style: z.string().max(200).optional(),
  shots: z.array(shotInputSchema).min(1).max(12),
});

const updateStoryboardSchema = z.object({
  storyboardId: storyboardIdSchema,
  title: z.string().min(1).max(80).optional(),
  brief: z.string().max(1000).optional(),
  aspectRatio: z.enum(ASPECTS).optional(),
  style: z.string().max(200).optional(),
  status: z.enum(["draft", "ready", "generating", "completed"]).optional(),
  active: z.boolean().optional(),
});

const updateShotSchema = z.object({
  shotId: z.string().min(1).describe("镜头 id，来自 get_storyboard"),
  title: z.string().min(1).max(80).optional(),
  description: z.string().max(600).optional(),
  prompt: z.string().max(2000).optional(),
  durationSeconds: z.number().min(1).max(15).optional(),
  camera: z.string().max(80).optional(),
  transition: z.string().max(80).optional(),
  status: z.enum(["draft", "generating", "ready", "failed"]).optional(),
});

const reorderShotsSchema = z.object({
  storyboardId: storyboardIdSchema,
  shotIds: z.array(z.string().min(1)).min(1).max(12).describe("新顺序的镜头 id，必须覆盖当前所有镜头"),
});

const deleteShotSchema = z.object({
  shotId: z.string().min(1),
  confirm: z.boolean().describe("只有用户明确确认删除后才传 true"),
});

const resetShotSchema = z.object({
  shotId: z.string().min(1),
});

const resetStoryboardSchema = z.object({
  storyboardId: storyboardIdSchema,
  confirm: z.boolean().describe("只有用户明确确认清空当前版本后才传 true"),
});

const restoreStoryboardSchema = z.object({
  storyboardId: storyboardIdSchema,
  revisionId: z.string().min(1).describe("历史版本 id，来自 get_storyboard 的 revisions"),
});

const setShotAssetSchema = z.object({
  shotId: z.string().min(1),
  assetId: z.string().min(1).describe("要设为该镜头当前版本的资产 id"),
});

async function attachArtifactToShot(
  projectId: string,
  shotId: string | undefined,
  assetId: string,
): Promise<void> {
  if (!shotId) return;
  try {
    const repo = await getStoryboardsRepository();
    await repo.applyAssetToShot(projectId, shotId, assetId);
  } catch (err) {
    console.warn(
      "[storyboards] 生成资产挂镜头失败：",
      err instanceof Error ? err.message : err,
    );
  }
}

type ToolContext = {
  bus: AgentEventBus;
  projectId: string;
  threadId?: string;
  attachmentMap: Record<string, string>;
  canvasSummary: string;
  canvasElements: CanvasElementBrief[];
  /** 项目产物账本（按时间倒序）；用于跨轮引用和分镜 */
  projectAssets: ProjectAsset[];
  baseUrl: string;
  signal: AbortSignal;
};

export function createAgentTools(context: ToolContext) {
  return [
    tool(
      async (input) => {
        const referenceImages = await resolveReferences(
          input.inputImages,
          context.attachmentMap,
          context.projectAssets,
        );

        if (jobsEnabled()) {
          try {
            context.bus.push({ type: "progress", progress: 5, stage: "提交生成作业" });
            const job = await createJob({
              projectId: context.projectId,
              type: "image_generation",
              ...(context.threadId ? { threadId: context.threadId } : {}),
              payload: {
                prompt: input.prompt,
                title: input.title,
                aspectRatio: input.aspectRatio,
                inputImages: referenceImages,
                sourceAssetIds: input.inputImages ?? [],
                ...(input.shotId ? { shotId: input.shotId } : {}),
              },
            });
            const finished = await waitForJob(context.projectId, job.id, {
              timeoutMs: 120_000,
              signal: context.signal,
              onProgress: (progressJob) => {
                context.bus.push({
                  type: "progress",
                  progress: progressJob.progress,
                  stage: progressJob.stage ?? "生成中",
                });
              },
            });
            if (context.signal.aborted) {
              await cancelJob(context.projectId, job.id).catch(() => undefined);
              throw Object.assign(new Error("生成已取消"), { name: "AbortError" });
            }

            if (finished?.status === "succeeded") {
              const result = finished.result as {
                artifact?: ImageBlock;
              };
              if (result?.artifact) {
                await attachArtifactToShot(
                  context.projectId,
                  input.shotId,
                  result.artifact.id,
                );
                return JSON.stringify({
                  summary: `已生成图片「${result.artifact.title ?? input.title}」并放到画布。`,
                  artifact: result.artifact,
                  jobId: finished.id,
                });
              }
            }

            if (finished && (finished.status === "failed" || finished.status === "canceled")) {
              return JSON.stringify({
                error: finished.errorMessage ?? "图片生成失败，请重试",
                code: finished.errorCode ?? "job_failed",
                jobId: finished.id,
                jobType: "image_generation",
              });
            }

            return JSON.stringify({
              summary: "图片还在生成，完成后会自动放到画布，不用重复提交。",
              error: "generation timed out",
              code: "job_timeout",
              jobId: job.id,
              jobType: "image_generation",
            });
          } catch (err) {
            if (context.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
              throw err;
            }
            console.warn(
              "[jobs] 提交图片作业失败，退回直连生成：",
              err instanceof Error ? err.message : err,
            );
          }
        }

        context.bus.push({ type: "progress", progress: 12, stage: "提交给 Seedream" });
        try {
          const result = await generateImageWithVolces({
            prompt: input.prompt,
            aspectRatio: input.aspectRatio as AspectRatio,
            referenceImages,
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
            title: input.title,
            prompt: input.prompt.slice(0, 2000),
            model: "Seedream 5.0 Lite",
            aspectRatio: input.aspectRatio,
            sourceAssetIds: input.inputImages ?? [],
            ...(input.shotId ? { shotId: input.shotId } : {}),
          };

          await attachArtifactToShot(context.projectId, input.shotId, artifact.id);

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
        const referenceImages = (
          await resolveReferences(
            input.inputImages,
            context.attachmentMap,
            context.projectAssets,
          )
        ).slice(0, 2);

        if (jobsEnabled()) {
          try {
            context.bus.push({ type: "progress", progress: 5, stage: "提交生成作业" });
            const job = await createJob({
              projectId: context.projectId,
              type: "video_generation",
              ...(context.threadId ? { threadId: context.threadId } : {}),
              payload: {
                prompt: input.prompt,
                title: input.title,
                aspectRatio: input.aspectRatio,
                durationSeconds: input.durationSeconds ?? 8,
                inputImages: referenceImages,
                sourceAssetIds: input.inputImages ?? [],
                ...(input.shotId ? { shotId: input.shotId } : {}),
              },
            });
            const finished = await waitForJob(context.projectId, job.id, {
              timeoutMs: 600_000,
              signal: context.signal,
              onProgress: (progressJob) => {
                context.bus.push({
                  type: "progress",
                  progress: progressJob.progress,
                  stage: progressJob.stage ?? "渲染中",
                });
              },
            });
            if (context.signal.aborted) {
              await cancelJob(context.projectId, job.id).catch(() => undefined);
              throw Object.assign(new Error("生成已取消"), { name: "AbortError" });
            }

            if (finished?.status === "succeeded") {
              const result = finished.result as {
                artifact?: VideoBlock;
              };
              if (result?.artifact) {
                await attachArtifactToShot(
                  context.projectId,
                  input.shotId,
                  result.artifact.id,
                );
                return JSON.stringify({
                  summary: `已生成视频「${result.artifact.title ?? input.title}」。`,
                  artifact: result.artifact,
                  jobId: finished.id,
                });
              }
            }

            if (finished && (finished.status === "failed" || finished.status === "canceled")) {
              return JSON.stringify({
                error: finished.errorMessage ?? "视频生成失败，请重试",
                code: finished.errorCode ?? "job_failed",
                jobId: finished.id,
                jobType: "video_generation",
              });
            }

            return JSON.stringify({
              summary: "视频还在生成，完成后会自动出现在对话里，不用重复提交。",
              error: "generation timed out",
              code: "job_timeout",
              jobId: job.id,
              jobType: "video_generation",
            });
          } catch (err) {
            if (context.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
              throw err;
            }
            console.warn(
              "[jobs] 提交视频作业失败，退回直连生成：",
              err instanceof Error ? err.message : err,
            );
          }
        }

        context.bus.push({ type: "progress", progress: 8, stage: "提交任务" });
        try {
          const result = await generateVideoWithMetaso({
            prompt: input.prompt,
            aspectRatio: input.aspectRatio as AspectRatio,
            durationSeconds: input.durationSeconds ?? 8,
            referenceImages,
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
            title: input.title,
            prompt: input.prompt.slice(0, 2000),
            model: "MiniMax H3",
            sourceAssetIds: input.inputImages ?? [],
            ...(input.shotId ? { shotId: input.shotId } : {}),
          };

          await attachArtifactToShot(context.projectId, input.shotId, artifact.id);

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
      async (input) => {
        const questions = input.questions.map((item, index) => ({
          id: `q${index + 1}`,
          question: item.question,
          allowCustom: true,
          options: item.options.map((label, optionIndex) => ({
            id: `q${index + 1}o${optionIndex + 1}`,
            label,
          })),
        }));
        return JSON.stringify({ summary: "等待用户逐项回答", questions });
      },
      {
        name: "offer_choices",
        description:
          "当 1-3 个关键信息各自有 2-4 个清晰互斥的候选答案时调用，前端会渲染成逐题回答的提问卡：用户逐个选择或自定义输入，点提交后把全部回答发回。调用前正文只写一句不超过 40 字的承接，不要重复问题或选项，也不要用「以上/下面」指代题目；不要用它给下一步动作、确认收到或替代开放性问题。",
        schema: choicesSchema,
      },
    ),
    tool(
      async (input) => {
        const query = input.query?.trim().toLowerCase();
        const assets = context.projectAssets
          .filter((asset) => !input.kind || asset.kind === input.kind)
          .filter((asset) => {
            if (!query) return true;
            return [asset.title, asset.prompt, asset.model ?? "", asset.shotId ?? ""]
              .join(" ")
              .toLowerCase()
              .includes(query);
          })
          .slice(0, input.limit ?? 10)
          .map((asset) => ({
            id: asset.id,
            kind: asset.kind,
            title: asset.title,
            prompt: asset.prompt.slice(0, 600),
            ...(asset.model ? { model: asset.model } : {}),
            width: asset.width,
            height: asset.height,
            ...(asset.durationSeconds ? { durationSeconds: asset.durationSeconds } : {}),
            ...(asset.shotId ? { shotId: asset.shotId } : {}),
            createdAt: asset.createdAt,
          }));

        return JSON.stringify({
          summary: assets.length
            ? `找到 ${assets.length} 个项目资产`
            : "项目资产里没有匹配项",
          assets,
        });
      },
      {
        name: "list_assets",
        description:
          "查询项目里生成过的图片/视频资产。按标题、prompt、模型或分镜筛选；只返回摘要，完整 prompt 用 get_asset。跨轮引用上一轮结果、版本对比、分镜找镜头当前资产时使用。",
        schema: listAssetsSchema,
      },
    ),
    tool(
      async (input) => {
        const asset = context.projectAssets.find((item) => item.id === input.assetId);
        if (!asset) {
          return JSON.stringify({
            error: `找不到资产 ${input.assetId}。请用 <project_assets> 或 list_assets 里的 id，不要编造。`,
          });
        }
        return JSON.stringify({
          asset: {
            id: asset.id,
            kind: asset.kind,
            title: asset.title,
            prompt: asset.prompt,
            ...(asset.model ? { model: asset.model } : {}),
            width: asset.width,
            height: asset.height,
            ...(asset.durationSeconds ? { durationSeconds: asset.durationSeconds } : {}),
            ...(asset.aspectRatio ? { aspectRatio: asset.aspectRatio } : {}),
            ...(asset.shotId ? { shotId: asset.shotId } : {}),
            sourceAssetIds: asset.sourceAssetIds,
            createdAt: asset.createdAt,
          },
        });
      },
      {
        name: "get_asset",
        description:
          "按资产 id 取完整 prompt、模型、尺寸和来源血缘。用户要基于某张旧图重做、对比版本或引用分镜镜头资产时调用。",
        schema: getAssetSchema,
      },
    ),
    tool(
      async () => {
        const repo = await getStoryboardsRepository();
        const boards = await repo.list(context.projectId);
        return JSON.stringify({
          count: boards.length,
          storyboards: boards.map((board) => ({
            storyboard_id: board.id,
            title: board.title,
            brief: board.brief.slice(0, 120),
            status: board.status,
            active: board.active,
            ...(board.aspectRatio ? { aspect_ratio: board.aspectRatio } : {}),
            ...(board.style ? { style: board.style } : {}),
            shots: board.shotCount,
            ready: board.readyCount,
            updated_at: board.updatedAt,
          })),
        });
      },
      {
        name: "list_storyboards",
        description:
          "列出项目里的分镜摘要（标题、状态、镜头数）。用户提到“另一个分镜/之前那个片子”或要按标题定位时先调用。",
        schema: z.object({}),
      },
    ),
    tool(
      async (input) => {
        try {
          const repo = await getStoryboardsRepository();
          const detail = await repo.get(context.projectId, input.storyboardId);
          if (!detail) return JSON.stringify({ error: "找不到这个分镜" });
          const shots = activeShots(detail);
          const assets = await (await getAssetsRepository()).list(context.projectId, 80);
          const byShot = new Map<string, typeof assets>();
          for (const asset of assets) {
            if (!asset.shotId) continue;
            const list = byShot.get(asset.shotId) ?? [];
            list.push(asset);
            byShot.set(asset.shotId, list);
          }
          const revisions = await repo.listRevisions(
            context.projectId,
            input.storyboardId,
            10,
          );
          return JSON.stringify({
            storyboard: {
              storyboard_id: detail.storyboard.id,
              title: detail.storyboard.title,
              brief: detail.storyboard.brief,
              status: detail.storyboard.status,
              active: detail.storyboard.active,
              ...(detail.storyboard.aspectRatio
                ? { aspect_ratio: detail.storyboard.aspectRatio }
                : {}),
              ...(detail.storyboard.style ? { style: detail.storyboard.style } : {}),
            },
            shots: shots.map((shot) => ({
              shot_id: shot.id,
              order: shot.orderIndex,
              title: shot.title,
              status: shot.status,
              description: shot.description,
              ...(shot.prompt ? { prompt: shot.prompt.slice(0, 600) } : {}),
              ...(shot.durationSeconds ? { duration_seconds: shot.durationSeconds } : {}),
              ...(shot.camera ? { camera: shot.camera } : {}),
              ...(shot.transition ? { transition: shot.transition } : {}),
              ...(shot.activeAssetId ? { active_asset_id: shot.activeAssetId } : {}),
              versions: (byShot.get(shot.id) ?? []).slice(0, 6).map((asset) => ({
                asset_id: asset.id,
                kind: asset.kind,
                title: asset.title,
                created_at: asset.createdAt,
                active: asset.id === shot.activeAssetId,
              })),
            })),
            revisions: revisions.map((revision) => ({
              revision_id: revision.id,
              reason: revision.reason,
              created_at: revision.createdAt,
            })),
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : "读取分镜失败",
          });
        }
      },
      {
        name: "get_storyboard",
        description:
          "取分镜 + 全部镜头 + 每个镜头的历史版本 + 最近 revisions。改镜头、回退版本、判断当前 active 资产前必须调用。",
        schema: getStoryboardSchema,
      },
    ),
    tool(
      async (input) => {
        try {
          const repo = await getStoryboardsRepository();
          const detail = await repo.create(context.projectId, {
            title: input.title,
            brief: input.brief,
            ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
            ...(input.style ? { style: input.style } : {}),
            shots: input.shots,
          });
          return JSON.stringify({
            storyboard_id: detail.storyboard.id,
            title: detail.storyboard.title,
            shots: activeShots(detail).map((shot) => ({
              shot_id: shot.id,
              order: shot.orderIndex,
              title: shot.title,
            })),
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : "创建分镜失败",
          });
        }
      },
      {
        name: "create_storyboard",
        description:
          "创建结构化分镜和镜头草稿。用户确认分镜方向后调用；一次 1-12 个镜头，每个镜头先写标题/描述/prompt 草稿，不直接批量生成。",
        schema: createStoryboardSchema,
      },
    ),
    tool(
      async (input) => {
        try {
          const { storyboardId, ...patch } = input;
          const repo = await getStoryboardsRepository();
          const detail = await repo.updateStoryboard(context.projectId, storyboardId, patch);
          return JSON.stringify({
            storyboard_id: detail.storyboard.id,
            title: detail.storyboard.title,
            status: detail.storyboard.status,
            active: detail.storyboard.active,
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : "更新分镜失败",
          });
        }
      },
      {
        name: "update_storyboard",
        description: "改分镜标题、brief、画幅、风格、状态或 active。只传要改的字段。",
        schema: updateStoryboardSchema,
      },
    ),
    tool(
      async (input) => {
        try {
          const { shotId, ...patch } = input;
          const repo = await getStoryboardsRepository();
          const shot = await repo.updateShot(context.projectId, shotId, patch);
          return JSON.stringify({
            shot_id: shot.id,
            order: shot.orderIndex,
            title: shot.title,
            status: shot.status,
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : "更新镜头失败",
          });
        }
      },
      {
        name: "update_shot",
        description:
          "只改一个镜头的文字/时长/机位/转场。改第 N 个镜头时必须先用 get_storyboard 找到 shot_id，不要猜。",
        schema: updateShotSchema,
      },
    ),
    tool(
      async (input) => {
        try {
          const repo = await getStoryboardsRepository();
          const detail = await repo.reorder(
            context.projectId,
            input.storyboardId,
            input.shotIds,
          );
          return JSON.stringify({
            storyboard_id: detail.storyboard.id,
            order: activeShots(detail).map((shot) => ({
              shot_id: shot.id,
              order: shot.orderIndex,
              title: shot.title,
            })),
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : "调整镜头顺序失败",
          });
        }
      },
      {
        name: "reorder_shots",
        description:
          "重排镜头顺序；shotIds 必须覆盖当前所有镜头。先 get_storyboard 拿完整列表，不要漏镜头。",
        schema: reorderShotsSchema,
      },
    ),
    tool(
      async (input) => {
        try {
          const repo = await getStoryboardsRepository();
          if (!input.confirm) {
            const found = await repo.getShot(context.projectId, input.shotId);
            return JSON.stringify({
              error: "需要用户确认后才能删除镜头",
              code: "confirmation_required",
              shot: found
                ? { shot_id: found.shot.id, title: found.shot.title }
                : undefined,
            });
          }
          await repo.deleteShot(context.projectId, input.shotId);
          return JSON.stringify({ deleted: true, shot_id: input.shotId });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : "删除镜头失败",
          });
        }
      },
      {
        name: "delete_shot",
        description:
          "软删除一个镜头。必须先向用户说明影响并得到明确确认，再传 confirm=true。",
        schema: deleteShotSchema,
      },
    ),
    tool(
      async (input) => {
        try {
          const repo = await getStoryboardsRepository();
          const shot = await repo.resetShot(context.projectId, input.shotId);
          return JSON.stringify({
            shot_id: shot.id,
            title: shot.title,
            status: shot.status,
            active_asset_id: null,
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : "重置镜头失败",
          });
        }
      },
      {
        name: "reset_shot",
        description:
          "清空一个镜头的当前版本并回到 draft；历史资产仍保留，可用 set_shot_asset 切回。",
        schema: resetShotSchema,
      },
    ),
    tool(
      async (input) => {
        try {
          const repo = await getStoryboardsRepository();
          if (!input.confirm) {
            const detail = await repo.get(context.projectId, input.storyboardId);
            const shots = detail ? activeShots(detail) : [];
            return JSON.stringify({
              error: "需要用户确认后才能重置整个分镜",
              code: "confirmation_required",
              impact: {
                shots: shots.length,
                active_versions: shots.filter((shot) => shot.activeAssetId).length,
                note: "历史资产会保留，只清空各镜头当前版本",
              },
            });
          }
          const detail = await repo.resetStoryboard(
            context.projectId,
            input.storyboardId,
          );
          return JSON.stringify({
            storyboard_id: detail.storyboard.id,
            status: detail.storyboard.status,
            shots: activeShots(detail).length,
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : "重置分镜失败",
          });
        }
      },
      {
        name: "reset_storyboard",
        description:
          "重置整个分镜：先说明会清空几个镜头/几版当前资产，用户确认后传 confirm=true。历史资产不删除。",
        schema: resetStoryboardSchema,
      },
    ),
    tool(
      async (input) => {
        try {
          const repo = await getStoryboardsRepository();
          const detail = await repo.restoreStoryboard(
            context.projectId,
            input.storyboardId,
            input.revisionId,
          );
          return JSON.stringify({
            storyboard_id: detail.storyboard.id,
            title: detail.storyboard.title,
            shots: activeShots(detail).map((shot) => ({
              shot_id: shot.id,
              order: shot.orderIndex,
              title: shot.title,
              active_asset_id: shot.activeAssetId ?? null,
            })),
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : "恢复分镜失败",
          });
        }
      },
      {
        name: "restore_storyboard",
        description:
          "把分镜恢复到某个 revision（来自 get_storyboard 的 revisions）。恢复前会先保存当前状态，可再次反悔。",
        schema: restoreStoryboardSchema,
      },
    ),
    tool(
      async (input) => {
        try {
          const repo = await getStoryboardsRepository();
          const shot = await repo.setShotAsset(
            context.projectId,
            input.shotId,
            input.assetId,
          );
          return JSON.stringify({
            shot_id: shot.id,
            title: shot.title,
            active_asset_id: shot.activeAssetId,
            status: shot.status,
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : "切换镜头版本失败",
          });
        }
      },
      {
        name: "set_shot_asset",
        description:
          "把某个历史资产设为镜头当前版本（版本回退），不重新生成。asset_id 来自 get_storyboard 的 versions。",
        schema: setShotAssetSchema,
      },
    ),
    tool(
      async () =>
        JSON.stringify({ canvas: context.canvasSummary || "画布目前为空，没有任何元素。" }),
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

async function resolveReferences(
  input: string[] | undefined,
  attachmentMap: Record<string, string>,
  projectAssets: ProjectAsset[],
): Promise<string[]> {
  if (!input?.length) return [];
  const resolved: string[] = [];

  for (const item of input) {
    const direct = attachmentMap[item];
    if (direct) {
      resolved.push(direct);
      continue;
    }

    if (item.startsWith("http") || item.startsWith("data:")) {
      resolved.push(item);
      continue;
    }

    // 项目资产（即使已经从画布删掉）：把本地 /files 地址转成 data URL 再给 provider
    const asset = projectAssets.find((entry) => entry.id === item);
    if (!asset) continue;
    const dataUrl = await fileDataUrlFromUrl(asset.url);
    if (dataUrl) {
      resolved.push(dataUrl);
    } else if (asset.url.startsWith("http")) {
      resolved.push(asset.url);
    }
  }

  return resolved;
}

function errorResult(error: unknown): string {
  const message =
    error instanceof GenerationError ? error.message : "生成失败，供应商没有返回结果";
  const code = error instanceof GenerationError ? error.code : "provider_error";
  return JSON.stringify({ error: message, code });
}