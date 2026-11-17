import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import type {
  AnchorType,
  AspectRatio,
  CanvasCommand,
  ChatAttachment,
  ImageBlock,
  InspirationBlock,
  VideoBlock,
} from "@my-lovart/shared";
import { z } from "zod";
import type { ProjectAsset } from "../assets/assets.js";
import { env } from "../../lib/env.js";
import {
  fileDataUrlFromUrl,
  importFileBuffer,
  importRemoteFile,
} from "../files/file.store.js";
import { generateImage, generateVideo } from "../generation/index.js";
import { extractVideoLastFrame } from "../generation/video-frame.js";
import { GenerationError, isAbortError } from "../generation/types.js";
import { searchPexelsPhotos } from "../inspiration/pexels.js";
import { createJob, cancelJob, jobsEnabled, waitForJob } from "../jobs/jobs.js";
import { getAssetsRepository } from "../assets/assets.repository.js";
import { getStoryboardsRepository } from "../storyboards/storyboards.repository.js";
import { activeShots, type Storyboard } from "../storyboards/storyboards.js";
import {
  policyDescription,
  readConsistencyPolicy,
  type ConsistencyPolicy,
} from "../storyboards/policy.js";
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
    .describe("要挂到的分镜镜头 id；生成成功后自动成为该镜头首帧（role=keyframe）或尾帧（role=end_frame）"),
  storyboardId: z
    .string()
    .min(1)
    .optional()
    .describe("role=canon 时必填，把设定图挂到这个分镜"),
  anchorType: z
    .enum(["product", "product_detail", "character", "scene", "style"])
    .optional()
    .default("product")
    .describe(
      "role=canon 的锚点类型：product 产品主体（必需）、product_detail 开盖/螺纹/内胆/工艺细节（必须有对应实拍）、character 角色、scene 场景、style 主视觉；没有人物就不要生成 character",
    ),
  role: z
    .enum(["free", "canon", "keyframe", "end_frame"])
    .optional()
    .describe(
      "图片角色。canon=产品/角色设定图，视频的第一步；keyframe=镜头首帧，必须基于 canon；end_frame=镜头尾帧；free=普通图片",
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "可选模型 id 或展示名。只有用户明确指定某模型/渠道时才传；不传用服务端 IMAGE_MODEL 默认值",
    ),
  quality: z
    .enum(["standard", "hd", "ultra"])
    .optional()
    .describe("可选清晰度档位：standard≈1K、hd≈2K、ultra≈4K；只有用户明确要求分辨率时才传"),
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
  direct: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "单条视频直接出片：用户给了主体图做 image-to-video（传 inputImages），或用户原话明确说“直接出片/不用确认”时传 true；其他视频保持 false，先给脚本和画面。",
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("可选视频模型 id 或展示名。只有用户明确指定某模型时才传；不传用服务端 VIDEO_MODEL 默认值"),
  resolution: z
    .enum(["480p", "720p", "1080p"])
    .optional()
    .describe("可选输出分辨率，只有用户明确要求时才传"),
});

const registerReferenceSchema = z.object({
  title: z.string().min(1).max(80).describe("给这张参考图一个短标题，例如「用户提供的角色形象」"),
  assetId: z
    .string()
    .min(1)
    .describe("直接复用用户提供的图：<input_images> 的 asset_id（asset-…）或项目资产 id"),
  storyboardId: z.string().min(1).describe("要挂到哪个视频分镜；多镜头必须传"),
  anchorType: z
    .enum(["product", "character", "scene", "style"])
    .optional()
    .default("character")
    .describe("这张参考图代表哪类身份基准；角色视频用 character，产品视频用 product"),
});

const searchInspirationSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("这组灵感搜索的短标题，例如「晨间通勤方向参考」"),
  directions: z
    .array(
      z.object({
        label: z
          .string()
          .min(1)
          .max(30)
          .describe("给用户看的方向名，必须用中文，例如「日系留白」「暗调产品」「街头抓拍」"),
        query: z
          .string()
          .min(1)
          .max(160)
          .describe(
            "Pexels 英文检索词：具体视觉物品 + 场景 + 光线/构图/风格。不要只写抽象情绪词，例如 morning sunlight commuter thermos minimal still life",
          ),
      }),
    )
    .min(1)
    .max(3)
    .describe("1-3 个视觉方向。用户没有明确方向时给 2-3 个；用户已有明确参考时只搜 1 个"),
  orientation: z
    .enum(["landscape", "portrait", "square"])
    .optional()
    .describe("参考图方向；视频 9:16 用 portrait，横屏用 landscape，方形用 square"),
  color: z
    .string()
    .max(20)
    .optional()
    .describe("可选主色筛选（Pexels 支持的颜色名，如 warm、black、white、blue）"),
  perPage: z
    .number()
    .int()
    .min(2)
    .max(6)
    .optional()
    .default(4)
    .describe("每个方向返回几张，默认 4 张，最多 6 张"),
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
  sceneGoal: z
    .string()
    .max(120)
    .optional()
    .describe("这一镜的职责：开场建立 / 卖点强调 / 承接 / 收尾；不要每镜重复"),
  continuityNote: z
    .string()
    .max(300)
    .optional()
    .describe("承接上一镜什么、结束时给下一镜留下什么；单镜头写内部节拍"),
  negativePrompt: z
    .string()
    .max(300)
    .optional()
    .describe("这一镜不允许出现的内容：多余文字、错误材质、无关人物等"),
});

const createStoryboardSchema = z.object({
  title: z.string().min(1).max(80),
  brief: z.string().min(1).max(1000).describe("分镜目标/用途"),
  kind: z
    .enum(["image", "video"])
    .optional()
    .default("image")
    .describe("video=要出片的视频时间线；image=纯视觉分镜/概念图，不含成片时长"),
  aspectRatio: z.enum(ASPECTS).optional(),
  style: z.string().max(200).optional(),
  canonAssetId: z
    .string()
    .min(1)
    .optional()
    .describe("已确认的产品/角色设定图 asset_id；视频分镜必须先有 canon"),
  totalDurationSeconds: z
    .number()
    .min(4)
    .max(15)
    .optional()
    .describe("视频成片总时长；kind=video 必填。5 秒=1 个镜头，10 秒最多 2 个镜头"),
  consistency: z
    .enum(["strict", "adaptive", "loose"])
    .optional()
    .default("adaptive")
    .describe(
      "一致性策略。strict=客户有产品实拍/明确要求不能变形，锚图必须有真实参考、多镜头必须末帧衔接；adaptive=有实拍用实拍，没有则生成设定图并标注（默认）；loose=快速草稿，允许无锚图、不强制末帧衔接",
    ),
  shots: z.array(shotInputSchema).min(1).max(12),
});

const updateStoryboardSchema = z.object({
  storyboardId: storyboardIdSchema,
  title: z.string().min(1).max(80).optional(),
  brief: z.string().max(1000).optional(),
  kind: z.enum(["image", "video"]).optional(),
  aspectRatio: z.enum(ASPECTS).optional(),
  style: z.string().max(200).optional(),
  canonAssetId: z.string().min(1).nullable().optional().describe("设定图 asset_id；null 表示清空"),
  totalDurationSeconds: z.number().min(4).max(15).optional(),
  status: z.enum(["draft", "ready", "generating", "completed"]).optional(),
  active: z.boolean().optional(),
  consistency: z
    .enum(["strict", "adaptive", "loose"])
    .optional()
    .describe("切换一致性策略；只改这一项时不影响其他 metadata"),
});

const updateShotSchema = z.object({
  shotId: z.string().min(1).describe("镜头 id，来自 get_storyboard"),
  title: z.string().min(1).max(80).optional(),
  description: z.string().max(600).optional(),
  prompt: z.string().max(2000).optional(),
  durationSeconds: z.number().min(1).max(15).optional(),
  camera: z.string().max(80).optional(),
  transition: z.string().max(80).optional(),
  sceneGoal: z.string().max(120).optional(),
  continuityNote: z.string().max(300).optional(),
  negativePrompt: z.string().max(300).optional(),
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
  artifact: ImageBlock,
  role: ImageRole = "keyframe",
  storyboardId?: string,
  anchorType: AnchorType = "product",
): Promise<void> {
  try {
    // 先落资产再写指针：canon/first_frame 都有外键约束，不能先指针后资产
    await (await getAssetsRepository()).save(projectId, {
      id: artifact.id,
      projectId,
      kind: "image",
      origin: "generated",
      title: artifact.title?.trim() || artifact.prompt?.slice(0, 40) || "未命名图片",
      prompt: artifact.prompt ?? "",
      ...(artifact.model ? { model: artifact.model } : {}),
      url: artifact.url,
      mimeType: artifact.mimeType,
      width: artifact.width,
      height: artifact.height,
      ...(artifact.aspectRatio ? { aspectRatio: artifact.aspectRatio } : {}),
      sourceAssetIds: artifact.sourceAssetIds ?? [],
      ...(shotId ? { shotId } : {}),
      metadata: { role, ...(role === "canon" ? { anchorType } : {}) },
      createdAt: new Date().toISOString(),
    });
    const repo = await getStoryboardsRepository();
    if (role === "canon") {
      if (storyboardId) {
        await repo.setAnchorAsset(projectId, storyboardId, anchorType, artifact.id);
      }
      return;
    }
    if (!shotId) return;
    if (role === "end_frame") {
      await repo.applyEndFrame(projectId, shotId, artifact.id);
    } else {
      await repo.applyFirstFrame(projectId, shotId, artifact.id);
    }
  } catch (err) {
    console.warn(
      "[storyboards] 生成资产挂镜头失败：",
      err instanceof Error ? err.message : err,
    );
  }
}

type ImageRole = "free" | "canon" | "keyframe" | "end_frame";

type ImageReferencePlan = {
  role: ImageRole;
  references: string[];
  sourceAssetIds: string[];
  anchorType?: AnchorType;
  canonId?: string;
  shotId?: string;
  storyboardId?: string;
  /** 镜头职责/衔接/禁止项的文本，生成时附到 prompt，确保和脚本一致 */
  shotDirection?: string;
  /** 当前分镜采用的一致性策略 */
  policy?: ConsistencyPolicy;
  /** 非阻断提示，例如“没有实拍，已按文字生成设定图” */
  warning?: string;
  error?: Record<string, unknown>;
};

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * 判断脚本是否真的要求“开盖/螺纹/内胆”等状态。
 * 不能只做关键词命中：客户常写“杯盖保持闭合，不要出现开盖、螺纹、内胆”，
 * 这些否定词是在排除状态，不是在要求状态。按句子看：否定词出现在状态词之前就跳过。
 */
export function promptRequiresProductDetail(text: string): boolean {
  const state = /开盖|打开|拧开|螺纹|内胆|杯口内部|盖内|倒水|出水/;
  const negative = /不|禁止|无|没有|避免|不得|勿/;
  for (const sentence of text.split(/[。；;\n]/)) {
    const match = sentence.match(state);
    if (!match || match.index === undefined) continue;
    if (negative.test(sentence.slice(0, match.index))) continue;
    return true;
  }
  return false;
}

/**
 * 图片生成的参考图计划：
 * - canon：产品/角色/场景/主视觉锚图，可引用用户上传的产品图；
 * - keyframe：自动引用该分镜全部锚图，并承接上一镜头尾帧；
 * - end_frame：引用锚图 + 当前镜头首帧，保证这一镜结尾能接下一镜；
 * - free：普通图片，不参与视频前期。
 */
export async function planImageReferences(
  context: ToolContext,
  input: {
    role?: ImageRole;
    shotId?: string;
    storyboardId?: string;
    anchorType?: AnchorType;
    inputImages?: string[];
    prompt?: string;
  },
): Promise<ImageReferencePlan> {
  const role: ImageRole = input.role ?? (input.shotId ? "keyframe" : "free");
  const explicit = await resolveReferences(
    input.inputImages,
    context.attachmentMap,
    context.projectAssets,
  );

  if (role === "free") {
    return { role, references: explicit, sourceAssetIds: [] };
  }

  if (role === "canon") {
    const anchorType = input.anchorType ?? "product";
    if (input.shotId) {
      return {
        role,
        references: explicit,
        sourceAssetIds: [],
        anchorType,
        error: {
          error: "锚图不能挂到某个镜头；role=canon 只传 storyboardId 或不传",
          code: "invalid_canon_target",
        },
      };
    }

    let board: Storyboard | null = null;
    if (input.storyboardId) {
      const repo = await getStoryboardsRepository();
      const detail = await repo.get(context.projectId, input.storyboardId);
      board = detail?.storyboard ?? null;
      if (!board) {
        return {
          role,
          references: explicit,
          sourceAssetIds: [],
          anchorType,
          error: { error: "找不到这个分镜，不能挂锚图", code: "invalid_storyboard" },
        };
      }
    }
    const policy = readConsistencyPolicy(board);
    const requiresPhoto =
      policy === "strict" && (anchorType === "product" || anchorType === "product_detail");

    if (requiresPhoto && explicit.length === 0) {
      return {
        role,
        references: [],
        sourceAssetIds: [],
        anchorType,
        policy,
        error: {
          error:
            anchorType === "product_detail"
              ? "strict 策略下，产品细节锚图必须基于真实细节实拍（开盖/螺纹/内胆/工艺），不能纯文生图。先上传对应细节图，或把该分镜切到 adaptive。"
              : "strict 策略下，产品锚图必须基于真实产品实拍，不能纯文生图。请上传产品正面/侧面/背面/俯视图，或把该分镜切到 adaptive。",
          code:
            anchorType === "product_detail"
              ? "detail_photo_required"
              : "canon_photo_required",
          next:
            anchorType === "product_detail"
              ? "上传开盖/细节实拍 → generate_image(role=canon, anchorType=product_detail, storyboardId, inputImages=[实拍])"
              : "请用户上传产品实拍图 → generate_image(role=canon, anchorType=product, storyboardId, inputImages=[实拍])",
        },
      };
    }

    const references = [...explicit];
    const sourceAssetIds: string[] = [];
    let warning: string | undefined;

    // 非 strict：允许没有实拍。细节锚图尽量以产品锚图为参考，而不是完全凭空生成。
    if (
      (anchorType === "product" || anchorType === "product_detail") &&
      explicit.length === 0
    ) {
      warning =
        anchorType === "product_detail"
          ? "没有细节实拍：已按当前产品设定图生成细节锚图。这个锚图只能作为草案参考，交付前建议补真实开盖/内壁图。"
          : "没有产品实拍：已按文字描述生成产品设定图。这是生成图，不是客户真实产品；严格还原需要客户补实拍。";
    }
    if (anchorType === "product_detail" && explicit.length === 0 && board?.canonAssetId) {
      const canon = await (await getAssetsRepository()).get(
        context.projectId,
        board.canonAssetId,
      );
      if (canon?.kind === "image") {
        references.push((await fileDataUrlFromUrl(canon.url)) ?? canon.url);
        sourceAssetIds.push(canon.id);
      }
    }

    return {
      role,
      references: references.slice(0, 4),
      sourceAssetIds,
      anchorType,
      policy,
      ...(warning ? { warning } : {}),
      ...(input.storyboardId ? { storyboardId: input.storyboardId } : {}),
    };
  }

  if (!input.shotId) {
    return {
      role,
      references: explicit,
      sourceAssetIds: [],
      error: {
        error: "首帧/尾帧必须传 shotId，先建分镜镜头再出关键帧",
        code: "shot_required",
      },
    };
  }

  const repo = await getStoryboardsRepository();
  const found = await repo.getShot(context.projectId, input.shotId);
  if (!found) {
    return {
      role,
      references: explicit,
      sourceAssetIds: [],
      error: { error: "找不到这个镜头", code: "invalid_shot" },
    };
  }
  const board = found.storyboard;
  const policy = readConsistencyPolicy(board);
  if (!board.canonAssetId) {
    return {
      role,
      references: explicit,
      sourceAssetIds: [],
      shotId: input.shotId,
      policy,
      error: {
        error:
          "这个分镜还没有产品/角色设定图（canon），不能各自文生图。先生成产品锚图（有实拍就用实拍；没有实拍在 adaptive/loose 策略下可以先生成设定图），确认后再出关键帧。",
        code: "canon_required",
        next: "generate_image(role=canon, anchorType=product) → generate_image(role=canon, anchorType=style/scene 按需) → generate_image(shotId, role=keyframe)",
      },
    };
  }

  const assets = await getAssetsRepository();
  const anchorIds = [
    board.canonAssetId,
    board.productDetailAnchorAssetId,
    board.characterAnchorAssetId,
    board.sceneAnchorAssetId,
    board.styleAnchorAssetId,
  ].filter((id): id is string => Boolean(id));
  const anchorAssets = await Promise.all(
    anchorIds.map((id) => assets.get(context.projectId, id)),
  );
  const validAnchors = anchorAssets.filter(
    (asset): asset is ProjectAsset => Boolean(asset && asset.kind === "image"),
  );
  if (validAnchors.length === 0) {
    return {
      role,
      references: explicit,
      sourceAssetIds: [],
      shotId: input.shotId,
      error: {
        error: "分镜的锚图资产已不存在，请重新生成或指定产品锚图",
        code: "canon_missing",
      },
    };
  }
  const canon = validAnchors.find((asset) => asset.id === board.canonAssetId);
  const canonCreatedAt = canon ? new Date(canon.createdAt).getTime() : Number.NaN;
  if (
    policy !== "loose" &&
    canon &&
    Number.isFinite(canonCreatedAt) &&
    canonCreatedAt >= new Date(context.runStartedAt).getTime() - 2000
  ) {
    return {
      role,
      references: explicit,
      sourceAssetIds: [],
      shotId: input.shotId,
      policy,
      error: {
        error:
          "产品锚图是本轮刚生成的，用户还没确认“是不是这只产品”。先把锚图给用户看，下一轮确认后再出关键帧。",
        code: "canon_unconfirmed",
        canon_asset_id: canon.id,
      },
    };
  }

  const stateText = [
    found.shot.title,
    found.shot.description,
    found.shot.prompt,
    input.prompt,
  ].join(" ");
  const needsProductDetail = promptRequiresProductDetail(stateText);
  if (
    policy !== "loose" &&
    (role === "keyframe" || role === "end_frame") &&
    needsProductDetail &&
    !board.productDetailAnchorAssetId
  ) {
    return {
      role,
      references: explicit,
      sourceAssetIds: [],
      shotId: input.shotId,
      policy,
      error: {
        error:
          "这一镜涉及开盖/螺纹/内胆/倒水等状态，但分镜没有产品细节锚图。闭盖设定图推不出内部结构，模型会自己发明杯身比例和螺纹。先有细节锚图（strict 必须真实细节实拍；adaptive 可以基于产品设定图生成草案），再出关键帧。",
        code: "product_state_reference_required",
        next: "生成 generate_image(role=canon, anchorType=product_detail, storyboardId, inputImages=实拍或留空) → 再生成 keyframe；loose 策略可跳过",
      },
    };
  }

  const detail = await repo.get(context.projectId, board.id);
  const ordered = detail ? activeShots(detail) : [];
  const index = ordered.findIndex((shot) => shot.id === input.shotId);
  const previous = index > 0 ? ordered[index - 1] : undefined;

  const sourceAssetIds = validAnchors.map((asset) => asset.id);
  const currentRefs: string[] = [];
  const continuityRefs: string[] = [];

  // 重做同一镜首帧时，以当前已确认首帧为主参考：只改机位/动作，不要重新发明产品
  if (role === "keyframe") {
    const currentId = found.shot.firstFrameAssetId ?? found.shot.activeAssetId;
    if (currentId) {
      const current = await assets.get(context.projectId, currentId);
      if (current?.kind === "image") {
        currentRefs.push((await fileDataUrlFromUrl(current.url)) ?? current.url);
        sourceAssetIds.push(current.id);
      }
    }
  }

  if (role === "keyframe" && previous) {
    // 多镜头必须按镜序闭环：上一镜先出片、抽末帧，再出这一镜首帧。
    // loose 是快速草稿档，允许先出独立画面；交付前仍应切回 adaptive/strict 重跑。
    if (policy !== "loose" && !previous.videoAssetId) {
      return {
        role,
        references: explicit,
        sourceAssetIds,
        shotId: input.shotId,
        policy,
        error: {
          error: `上一镜「${previous.title}」还没有视频。多镜头要先把上一镜出片并抽末帧，再生成这一镜首帧，否则只能靠生成的尾帧近似。`,
          code: "previous_video_required",
          previous_shot_id: previous.id,
        },
      };
    }
    const continuityId = previous.videoLastFrameAssetId ?? previous.endFrameAssetId;
    if (policy !== "loose" && !continuityId) {
      return {
        role,
        references: explicit,
        sourceAssetIds,
        shotId: input.shotId,
        policy,
        error: {
          error: `上一镜「${previous.title}」既没有抽到实际末帧，也没有尾帧图，无法衔接。`,
          code: "previous_continuity_missing",
          previous_shot_id: previous.id,
        },
      };
    }
    if (continuityId) {
      const continuity = await assets.get(context.projectId, continuityId);
      if (continuity?.kind === "image") {
        continuityRefs.push((await fileDataUrlFromUrl(continuity.url)) ?? continuity.url);
        sourceAssetIds.push(continuity.id);
      }
    }
  }

  if (role === "end_frame") {
    const firstId = found.shot.firstFrameAssetId ?? found.shot.activeAssetId;
    if (!firstId) {
      return {
        role,
        references: explicit,
        sourceAssetIds,
        shotId: input.shotId,
        error: {
          error: "这一镜还没有首帧，不能生成尾帧；先生成 keyframe。",
          code: "first_frame_required",
        },
      };
    }
    const first = await assets.get(context.projectId, firstId);
    if (first?.kind === "image") {
      continuityRefs.push((await fileDataUrlFromUrl(first.url)) ?? first.url);
      sourceAssetIds.push(first.id);
    }
  }

  const primaryAnchorIds = new Set(
    [board.canonAssetId, board.productDetailAnchorAssetId, board.styleAnchorAssetId].filter(
      (id): id is string => Boolean(id),
    ),
  );
  const references = dedupe([
    ...currentRefs,
    ...(await Promise.all(
      validAnchors
        .filter((asset) => primaryAnchorIds.has(asset.id))
        .slice(0, 2)
        .map(async (asset) => (await fileDataUrlFromUrl(asset.url)) ?? asset.url),
    )),
    ...continuityRefs,
    ...explicit,
  ]).slice(0, 4);

  const shotDirection = [
    found.shot.sceneGoal ? `镜头职责：${found.shot.sceneGoal}` : "",
    found.shot.continuityNote ? `前后衔接：${found.shot.continuityNote}` : "",
    found.shot.negativePrompt ? `不要出现：${found.shot.negativePrompt}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    role,
    references,
    sourceAssetIds: dedupe(sourceAssetIds),
    canonId: board.canonAssetId,
    shotId: input.shotId,
    storyboardId: board.id,
    policy,
    ...(shotDirection ? { shotDirection } : {}),
  };
}

async function attachVideoToShot(
  projectId: string,
  shotId: string | undefined,
  artifact: VideoBlock,
  baseUrl: string,
): Promise<void> {
  if (!shotId) return;
  try {
    await (await getAssetsRepository()).save(projectId, {
      id: artifact.id,
      projectId,
      kind: "video",
      origin: "generated",
      title: artifact.title?.trim() || artifact.prompt?.slice(0, 40) || "未命名视频",
      prompt: artifact.prompt ?? "",
      ...(artifact.model ? { model: artifact.model } : {}),
      url: artifact.url,
      mimeType: artifact.mimeType,
      width: artifact.width,
      height: artifact.height,
      ...(artifact.durationSeconds ? { durationSeconds: artifact.durationSeconds } : {}),
      sourceAssetIds: artifact.sourceAssetIds ?? [],
      shotId,
      metadata: { role: "video" },
      createdAt: new Date().toISOString(),
    });
    const repo = await getStoryboardsRepository();
    await repo.applyVideo(projectId, shotId, artifact.id);

    const frame = await extractVideoLastFrame(artifact.url);
    if (frame) {
      const storedFrame = await importFileBuffer(
        frame,
        "image/jpeg",
        `${artifact.title ?? "视频"} 末帧`,
        baseUrl,
      );
      const frameAssetId = randomUUID();
      await (await getAssetsRepository()).save(projectId, {
        id: frameAssetId,
        projectId,
        kind: "image",
        origin: "derived",
        title: `${artifact.title ?? "视频"} 末帧`,
        prompt: `视频实际最后一帧：${artifact.title ?? artifact.prompt ?? ""}`,
        url: storedFrame.url,
        mimeType: "image/jpeg",
        width: artifact.width,
        height: artifact.height,
        sourceAssetIds: [artifact.id],
        shotId,
        metadata: { role: "video_last_frame", videoAssetId: artifact.id },
        createdAt: new Date().toISOString(),
      });
      await repo.applyVideoLastFrame(projectId, shotId, frameAssetId);
    }
  } catch (err) {
    console.warn(
      "[storyboards] 视频挂镜头失败：",
      err instanceof Error ? err.message : err,
    );
  }
}

/** 用户原话里的显式“跳过前期”授权，避免模型自己替用户决定。 */
export function userAllowsDirectVideo(text: string | undefined): boolean {
  return Boolean(text && /直接出片|不用确认|不用脚本|跳过确认|直接生成/.test(text));
}

/**
 * 单条视频直接出片的许可规则：
 * - 用户给了主体图（本轮附件或上传资产），就是 image-to-video，不需要 canon/关键帧；
 * - 或者用户原话明确说“直接出片/不用确认”；
 * - 两者都没有时，direct=true 视为偷懒，拒绝。
 */
export function checkDirectVideoInput(input: {
  direct: boolean;
  inputImages?: string[];
  attachmentMap: Record<string, string>;
  projectAssets: ProjectAsset[];
  userText?: string;
}): { allowed: boolean; source: boolean; reason?: string } {
  if (!input.direct) return { allowed: true, source: false };

  const sourceIds = input.inputImages ?? [];
  const hasUserSource = sourceIds.some((id) => {
    if (input.attachmentMap[id]) return true;
    return input.projectAssets.some(
      (asset) => asset.id === id && asset.origin === "uploaded",
    );
  });
  if (hasUserSource || userAllowsDirectVideo(input.userText)) {
    return { allowed: true, source: hasUserSource };
  }
  return {
    allowed: false,
    source: false,
    reason:
      "direct=true 只用于两种情况：用户提供了主体图（image-to-video 单条短片），或用户原话明确说“直接出片/不用确认”。其他视频先给脚本和画面。",
  };
}

export async function checkVideoPreflight(
  context: ToolContext,
  shotId: string | undefined,
  direct: boolean,
): Promise<Record<string, unknown> | null> {
  if (direct) return null;
  if (!shotId) {
    return {
      error:
        "视频不能直接生成。先写 1 个镜头的脚本（或分镜），生成首帧关键图，让用户确认脚本和画面后再生成视频。",
      code: "video_plan_required",
      next: "create_storyboard → generate_image(shotId) → 等用户确认 → generate_video(shotId)",
    };
  }
  const repo = await getStoryboardsRepository();
  const found = await repo.getShot(context.projectId, shotId);
  if (!found) {
    return { error: "找不到这个镜头，不能生成视频", code: "invalid_shot" };
  }
  const policy = readConsistencyPolicy(found.storyboard);
  const createdAt = new Date(found.shot.createdAt).getTime();
  const runStartedAt = new Date(context.runStartedAt).getTime();
  if (Number.isFinite(createdAt) && createdAt >= runStartedAt - 2000) {
    return {
      error:
        "这个镜头是本轮刚建的计划，用户还没看到脚本。先把脚本/镜头列表发给用户并停止，等下一轮确认后再生成视频。",
      code: "video_plan_unconfirmed",
      shot_id: found.shot.id,
    };
  }
  if (!found.storyboard.canonAssetId && policy !== "loose") {
    return {
      error:
        "这个视频分镜还没有产品/角色设定图（canon）。先生成并确认设定图（adaptive 允许没有实拍时先生成设定图；loose 可跳过），所有镜头都基于它，否则每个镜头会各自长成不同产品。",
      code: "canon_required",
      shot_id: found.shot.id,
      policy,
      next: "generate_image(role=canon) → update_storyboard(canonAssetId) → generate_image(shotId, role=keyframe)",
    };
  }
  const firstFrameId = found.shot.firstFrameAssetId ?? found.shot.activeAssetId;
  let keyframe: ProjectAsset | null = null;
  if (firstFrameId) {
    keyframe = await (await getAssetsRepository()).get(context.projectId, firstFrameId);
  }
  const frame = keyframe && keyframe.kind === "image" ? keyframe : null;
  if (!frame && policy !== "loose") {
    return {
      error:
        "这个镜头还没有首帧关键图。先用 generate_image(shotId, role=keyframe) 生成一张基于 canon 的关键画面，展示给用户确认，再生成视频。",
      code: "keyframe_required",
      shot_id: found.shot.id,
      policy,
    };
  }
  const canonId = found.storyboard.canonAssetId ?? "";
  if (
    policy !== "loose" &&
    frame &&
    (frame.metadata?.role !== "keyframe" ||
      !frame.sourceAssetIds.includes(canonId))
  ) {
    return {
      error:
        "这张首帧不是基于 canon 生成的关键帧，产品可能对不上。必须用 generate_image(shotId, role=keyframe) 重新出，服务端会把 canon 作为参考图。",
      code: "keyframe_not_anchored",
      shot_id: found.shot.id,
      policy,
    };
  }

  if (found.storyboard.kind === "video" && policy !== "loose") {
    const detail = await repo.get(context.projectId, found.storyboard.id);
    const ordered = detail ? activeShots(detail) : [];
    const index = ordered.findIndex((item) => item.id === found.shot.id);
    const previous = index > 0 ? ordered[index - 1] : undefined;
    const lastIndex = ordered.length - 1;

    if (previous) {
      if (!previous.videoAssetId) {
        return {
          error: `上一镜「${previous.title}」还没有视频。多镜头要按顺序先出上一镜，再出这一镜。`,
          code: "previous_video_required",
          previous_shot_id: previous.id,
        };
      }
      const continuityId = previous.videoLastFrameAssetId ?? previous.endFrameAssetId;
      if (!continuityId) {
        return {
          error: `上一镜「${previous.title}」没有可用的衔接帧（视频末帧和尾帧都缺）。`,
          code: "previous_continuity_missing",
          previous_shot_id: previous.id,
        };
      }
      const anchored =
        firstFrameId === continuityId ||
        (frame?.sourceAssetIds.includes(continuityId) ?? false);
      if (!anchored) {
        return {
          error:
            "这一镜首帧没有承接上一镜的实际末帧，剪辑点会跳。重新用 generate_image(shotId, role=keyframe) 出首帧，服务端会自动把上一镜末帧作为参考。",
          code: "continuity_not_anchored",
          previous_shot_id: previous.id,
        };
      }
    }

    if (index >= 0 && index < lastIndex && !found.shot.endFrameAssetId) {
      return {
        error:
          "多镜头分镜里，每个非收尾镜头都要有尾帧，才能和下一镜接上。先生成这一镜的 end_frame。",
        code: "end_frame_required",
        shot_id: found.shot.id,
      };
    }
  }

  const keyframeCreatedAt = frame ? new Date(frame.createdAt).getTime() : Number.NaN;
  if (
    frame &&
    Number.isFinite(keyframeCreatedAt) &&
    keyframeCreatedAt >= runStartedAt - 2000
  ) {
    return {
      error:
        "首帧关键图是本轮刚生成的，用户还没看到画面。先把脚本和关键图发给用户并停止，等下一轮确认后再生成视频。",
      code: "keyframe_unconfirmed",
      shot_id: found.shot.id,
    };
  }
  return null;
}

type ToolContext = {
  bus: AgentEventBus;
  projectId: string;
  runStartedAt: string;
  threadId?: string;
  /** 本轮用户原话：判断“直接出片”这类显式授权，不靠模型转述 */
  userText?: string;
  /** 本轮附件：用户提供的参考图可以直接变成 canon，而不必重新生成 */
  attachments?: ChatAttachment[];
  attachmentMap: Record<string, string>;
  canvasSummary: string;
  canvasElements: CanvasElementBrief[];
  /** 项目产物账本（按时间倒序）；用于跨轮引用和分镜 */
  projectAssets: ProjectAsset[];
  baseUrl: string;
  signal: AbortSignal;
};

export function createAgentTools(context: ToolContext) {
  const tools = [
    tool(
      async (input) => {
        const plan = await planImageReferences(context, {
          role: input.role,
          anchorType: input.anchorType,
          prompt: input.prompt,
          ...(input.shotId ? { shotId: input.shotId } : {}),
          ...(input.storyboardId ? { storyboardId: input.storyboardId } : {}),
          ...(input.inputImages ? { inputImages: input.inputImages } : {}),
        });
        if (plan.error) return JSON.stringify(plan.error);
        const referenceImages = plan.references;
        const role = plan.role;
        const sourceAssetIds = plan.sourceAssetIds;
        const identityLock =
          role === "keyframe" || role === "end_frame"
            ? "严格保持参考图主体的身份一致：形状、比例、接口/瓶盖结构、材质、颜色、标志位置，不要重新设计主体；只允许改变机位、光线、背景与构图。"
            : "";
        const prompt = [input.prompt, identityLock, plan.shotDirection]
          .filter(Boolean)
          .join("\n\n");

        if (jobsEnabled()) {
          try {
            context.bus.push({ type: "progress", progress: 5, stage: "提交生成作业" });
            const job = await createJob({
              projectId: context.projectId,
              type: "image_generation",
              ...(context.threadId ? { threadId: context.threadId } : {}),
              payload: {
                prompt,
                title: input.title,
                aspectRatio: input.aspectRatio,
                inputImages: referenceImages,
                sourceAssetIds,
                role,
                ...(input.model ? { model: input.model } : {}),
                ...(input.quality ? { quality: input.quality } : {}),
                ...(role === "canon" ? { anchorType: plan.anchorType ?? "product" } : {}),
                ...(input.shotId ? { shotId: input.shotId } : {}),
                ...(plan.storyboardId ? { storyboardId: plan.storyboardId } : {}),
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
                  result.artifact,
                  role,
                  plan.storyboardId,
                  plan.anchorType ?? "product",
                );
                return JSON.stringify({
                  summary: `已生成图片「${result.artifact.title ?? input.title}」并放到画布。${plan.warning ? `\n注意：${plan.warning}` : ""}`,
                  artifact: result.artifact,
                  jobId: finished.id,
                  ...(plan.policy ? { consistency: plan.policy } : {}),
                  ...(plan.warning ? { warning: plan.warning } : {}),
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

        context.bus.push({ type: "progress", progress: 12, stage: "提交生成任务" });
        try {
          const result = await generateImage({
            prompt,
            aspectRatio: input.aspectRatio as AspectRatio,
            referenceImages,
            ...(input.model ? { model: input.model } : {}),
            ...(input.quality ? { quality: input.quality } : {}),
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
            prompt: prompt.slice(0, 2000),
            model: result.modelDisplayName,
            aspectRatio: input.aspectRatio,
            role,
            ...(role === "canon" ? { anchorType: plan.anchorType ?? "product" } : {}),
            sourceAssetIds,
            ...(input.shotId ? { shotId: input.shotId } : {}),
          };

          await attachArtifactToShot(
            context.projectId,
            input.shotId,
            artifact,
            role,
            plan.storyboardId,
            plan.anchorType ?? "product",
          );

          return JSON.stringify({
            summary: `已生成${role === "canon" ? "设定图" : role === "keyframe" ? "关键帧" : role === "end_frame" ? "尾帧" : "图片"}「${input.title}」，${result.width}×${result.height}。${plan.warning ? `\n注意：${plan.warning}` : ""}`,
            artifact,
            ...(plan.policy ? { consistency: plan.policy } : {}),
            ...(plan.warning ? { warning: plan.warning } : {}),
          });
        } catch (error) {
          if (isAbortError(error, context.signal)) throw error;
          return errorResult(error);
        }
      },
      {
        name: "generate_image",
        description:
          "生成一张图片。视频前期：role=canon+anchorType=product 在有实拍时必须以实拍为参考；strict 策略缺实拍会被拒，adaptive/loose 可先生成设定图。product_detail 用于开盖/螺纹/内胆等状态；strict 必须有对应实拍，adaptive 可基于产品锚图生成草案。关键帧 role=keyframe/end_frame 会自动引用产品锚/细节锚/衔接帧，并追加身份锁定。普通画图不传 role。",
        schema: imageSchema,
      },
    ),
    tool(
      async (input) => {
        const direct = input.direct ?? false;
        const directCheck = checkDirectVideoInput({
          direct,
          ...(input.inputImages ? { inputImages: input.inputImages } : {}),
          attachmentMap: context.attachmentMap,
          projectAssets: context.projectAssets,
          ...(context.userText ? { userText: context.userText } : {}),
        });
        if (!directCheck.allowed) {
          return JSON.stringify({
            error: directCheck.reason,
            code: "direct_requires_source",
          });
        }

        const preflight = await checkVideoPreflight(
          context,
          input.shotId,
          direct,
        );
        if (preflight) return JSON.stringify(preflight);

        let referenceImages = (
          await resolveReferences(
            input.inputImages,
            context.attachmentMap,
            context.projectAssets,
          )
        ).slice(0, 2);
        let durationSeconds = input.durationSeconds ?? 8;
        let videoPrompt = input.prompt;
        const sourceAssetIds = [...(input.inputImages ?? [])];

        if (input.shotId) {
          // 有镜头时，首帧/尾帧由服务端锁定，不允许模型临时换图
          const found = await (await getStoryboardsRepository()).getShot(
            context.projectId,
            input.shotId,
          );
          if (found) {
            if (found.shot.durationSeconds) {
              durationSeconds = Math.round(found.shot.durationSeconds);
            }
            const frames: string[] = [];
            const firstId = found.shot.firstFrameAssetId ?? found.shot.activeAssetId;
            if (firstId) {
              const first = await (await getAssetsRepository()).get(
                context.projectId,
                firstId,
              );
              if (first?.kind === "image") {
                frames.push((await fileDataUrlFromUrl(first.url)) ?? first.url);
                sourceAssetIds.unshift(first.id);
              }
            }
            if (found.shot.endFrameAssetId) {
              const end = await (await getAssetsRepository()).get(
                context.projectId,
                found.shot.endFrameAssetId,
              );
              if (end?.kind === "image") {
                frames.push((await fileDataUrlFromUrl(end.url)) ?? end.url);
                sourceAssetIds.push(end.id);
              }
            }
            if (frames.length > 0) referenceImages = frames.slice(0, 2);
            const direction = [
              found.shot.sceneGoal ? `镜头职责：${found.shot.sceneGoal}` : "",
              found.shot.continuityNote ? `前后衔接：${found.shot.continuityNote}` : "",
              found.shot.negativePrompt ? `不要出现：${found.shot.negativePrompt}` : "",
            ]
              .filter(Boolean)
              .join("\n");
            if (direction) videoPrompt = `${input.prompt}\n\n${direction}`;
          }
        }

        if (jobsEnabled()) {
          try {
            context.bus.push({ type: "progress", progress: 5, stage: "提交生成作业" });
            const job = await createJob({
              projectId: context.projectId,
              type: "video_generation",
              ...(context.threadId ? { threadId: context.threadId } : {}),
              payload: {
                prompt: videoPrompt,
                title: input.title,
                aspectRatio: input.aspectRatio,
                durationSeconds,
                inputImages: referenceImages,
                sourceAssetIds,
                ...(input.model ? { model: input.model } : {}),
                ...(input.resolution ? { resolution: input.resolution } : {}),
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
          const result = await generateVideo({
            prompt: videoPrompt,
            aspectRatio: input.aspectRatio as AspectRatio,
            durationSeconds,
            referenceImages,
            ...(input.model ? { model: input.model } : {}),
            ...(input.resolution ? { resolution: input.resolution } : {}),
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
            prompt: videoPrompt.slice(0, 2000),
            model: result.modelDisplayName,
            sourceAssetIds,
            ...(input.shotId ? { shotId: input.shotId } : {}),
          };

          await attachVideoToShot(context.projectId, input.shotId, artifact, context.baseUrl);

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
          "生成一条视频。两种模式：①单条 image-to-video：用户给了主体图并要单镜头动效，传 inputImages=[那张图]、direct=true，不需要分镜/canon/关键帧；②多镜头或纯文字概念片：先有 canon 身份基准、镜头脚本和该镜头首帧，strict/adaptive 会强制这些前期，loose 允许直接按文字/参考生成。有镜头时首帧/尾帧由服务端锁定，时长取镜头 durationSeconds。",
        schema: videoSchema,
      },
    ),
    tool(
      async (input) => {
        const key = input.assetId.trim();
        const attachment =
          context.attachments?.find(
            (item) => key === item.id || key === `asset-${item.id}`,
          ) ?? null;
        const projectAsset =
          context.projectAssets.find((item) => item.id === key) ?? null;

        const assets = await getAssetsRepository();
        let assetId = "";
        let source: "user_upload" | "project_asset" = "user_upload";

        try {
          if (attachment) {
            const asset: ProjectAsset = {
              id: randomUUID(),
              projectId: context.projectId,
              kind: "image",
              origin: "uploaded",
              title: input.title,
              prompt: "",
              url: attachment.url,
              mimeType: attachment.mimeType,
              width: attachment.width ?? 0,
              height: attachment.height ?? 0,
              sourceAssetIds: [],
              metadata: {
                role: "canon",
                anchorType: input.anchorType,
                source: "user_upload",
              },
              createdAt: new Date().toISOString(),
            };
            await assets.save(context.projectId, asset);
            assetId = asset.id;
          } else if (projectAsset && projectAsset.kind === "image") {
            assetId = projectAsset.id;
            source = "project_asset";
          } else {
            return JSON.stringify({
              error:
                "找不到这张参考图。用户图要用 <input_images> 里的 asset_id；项目里生成过的图才用资产 id。",
              code: "reference_not_found",
            });
          }

          const repo = await getStoryboardsRepository();
          const board = await repo.setAnchorAsset(
            context.projectId,
            input.storyboardId,
            input.anchorType,
            assetId,
          );

          return JSON.stringify({
            summary: `已把「${input.title}」登记为该分镜的${input.anchorType === "character" ? "角色" : input.anchorType}身份基准（canon），后续镜头直接以它为参考，不需要再生成一版设定图。`,
            asset_id: assetId,
            storyboard_id: board.id,
            anchor_type: input.anchorType,
            canon_asset_id: board.canonAssetId ?? null,
            source,
          });
        } catch (error) {
          return errorResult(error);
        }
      },
      {
        name: "register_reference",
        description:
          "把用户已经提供的图直接登记为分镜的身份基准（canon），不重新生成。适合：用户上传角色/产品参考图，随后要做多镜头视频。登记后关键帧以它为参考；只有确实需要新角度/干净转面图时才再生成图。单镜头 image-to-video 不需要调用这个工具，直接把图传给 generate_video 的 inputImages。",
        schema: registerReferenceSchema,
      },
    ),
    tool(
      async (input) => {
        const settled = await Promise.allSettled(
          input.directions.map(async (direction) => ({
            direction,
            items: await searchPexelsPhotos({
              query: direction.query,
              perPage: input.perPage,
              ...(input.orientation ? { orientation: input.orientation } : {}),
              ...(input.color ? { color: input.color } : {}),
              signal: context.signal,
            }),
          })),
        );

        const blocks: InspirationBlock[] = [];
        const failures: string[] = [];
        for (const result of settled) {
          if (result.status === "rejected") {
            const reason = result.reason;
            failures.push(
              reason instanceof GenerationError
                ? `${reason.code}：${reason.message}`
                : "灵感搜索失败",
            );
            continue;
          }
          const { direction, items } = result.value;
          if (items.length === 0) continue;
          blocks.push({
            type: "inspiration",
            id: randomUUID(),
            query: `${direction.label}｜${direction.query}`,
            items,
          });
        }

        if (blocks.length === 0) {
          return JSON.stringify({
            error: failures[0] ?? "没有搜索到可用的灵感图，换一组具体视觉词再试",
            code: "inspiration_empty",
          });
        }

        const total = blocks.reduce((sum, block) => sum + block.items.length, 0);
        const selection = blocks.map((block, groupIndex) => ({
          group: groupIndex + 1,
          label: block.query.split("｜")[0],
          items: block.items.map((item, itemIndex) => ({
            ref: `G${groupIndex + 1}-${itemIndex + 1}`,
            index: itemIndex + 1,
            title: item.title,
            imageUrl: item.imageUrl,
            source: item.source,
          })),
        }));
        return JSON.stringify({
          summary: `找到 ${blocks.length} 组方向、${total} 张灵感图${failures.length ? `；${failures.length} 组失败` : ""}。请让用户看图选方向，选定后再生成。用户说“第几组第几张”时，按 selection 里的 group/items 顺序对应（组顺序即展示顺序，张顺序即卡片顺序），把选中的 imageUrl 直接作为 generate_image 的 inputImages 使用，不要重新搜图。`,
          artifacts: blocks,
          selection,
          directions: blocks.map((block) => block.query),
          ...(failures.length ? { warnings: failures } : {}),
        });
      },
      {
        name: "search_inspiration",
        description:
          "搜索公开视觉灵感/参考图，用于用户还没有明确风格、构图、配色方向时，或用户主动说“找灵感/参考/竞品/看看别人怎么做”。返回 1-3 组方向、每组 4-6 张图；本轮只给用户看图选择，不要同轮自动生成产品设定图、分镜或视频。用户已有明确参考图/产品实拍时不要调用。",
        schema: searchInspirationSchema,
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
              kind: detail.storyboard.kind,
              status: detail.storyboard.status,
              active: detail.storyboard.active,
              ...(detail.storyboard.canonAssetId
                ? { product_anchor_asset_id: detail.storyboard.canonAssetId }
                : {}),
              ...(detail.storyboard.productDetailAnchorAssetId
                ? {
                    product_detail_anchor_asset_id:
                      detail.storyboard.productDetailAnchorAssetId,
                  }
                : {}),
              ...(detail.storyboard.characterAnchorAssetId
                ? { character_anchor_asset_id: detail.storyboard.characterAnchorAssetId }
                : {}),
              ...(detail.storyboard.sceneAnchorAssetId
                ? { scene_anchor_asset_id: detail.storyboard.sceneAnchorAssetId }
                : {}),
              ...(detail.storyboard.styleAnchorAssetId
                ? { style_anchor_asset_id: detail.storyboard.styleAnchorAssetId }
                : {}),
              ...(detail.storyboard.totalDurationSeconds
                ? { total_duration_seconds: detail.storyboard.totalDurationSeconds }
                : {}),
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
              ...(shot.sceneGoal ? { scene_goal: shot.sceneGoal } : {}),
              ...(shot.continuityNote ? { continuity_note: shot.continuityNote } : {}),
              ...(shot.negativePrompt ? { negative_prompt: shot.negativePrompt } : {}),
              ...(shot.activeAssetId ? { active_asset_id: shot.activeAssetId } : {}),
              ...(shot.firstFrameAssetId
                ? { first_frame_asset_id: shot.firstFrameAssetId }
                : {}),
              ...(shot.endFrameAssetId ? { end_frame_asset_id: shot.endFrameAssetId } : {}),
              ...(shot.videoAssetId ? { video_asset_id: shot.videoAssetId } : {}),
              ...(shot.videoLastFrameAssetId
                ? { video_last_frame_asset_id: shot.videoLastFrameAssetId }
                : {}),
              versions: (byShot.get(shot.id) ?? []).slice(0, 8).map((asset) => ({
                asset_id: asset.id,
                kind: asset.kind,
                role: asset.metadata?.role ?? null,
                title: asset.title,
                created_at: asset.createdAt,
                active:
                  asset.id === shot.activeAssetId ||
                  asset.id === shot.firstFrameAssetId ||
                  asset.id === shot.endFrameAssetId ||
                  asset.id === shot.videoAssetId ||
                  asset.id === shot.videoLastFrameAssetId,
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
            kind: input.kind,
            ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
            ...(input.style ? { style: input.style } : {}),
            ...(input.canonAssetId ? { canonAssetId: input.canonAssetId } : {}),
            ...(input.totalDurationSeconds
              ? { totalDurationSeconds: input.totalDurationSeconds }
              : {}),
            metadata: { consistency: input.consistency },
            shots: input.shots,
          });
          return JSON.stringify({
            storyboard_id: detail.storyboard.id,
            title: detail.storyboard.title,
            kind: detail.storyboard.kind,
            total_duration_seconds: detail.storyboard.totalDurationSeconds,
            canon_asset_id: detail.storyboard.canonAssetId,
            consistency: readConsistencyPolicy(detail.storyboard),
            consistency_description: policyDescription(
              readConsistencyPolicy(detail.storyboard),
            ),
            shots: activeShots(detail).map((shot) => ({
              shot_id: shot.id,
              order: shot.orderIndex,
              title: shot.title,
              duration_seconds: shot.durationSeconds,
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
          "创建结构化分镜草稿。视频分镜必须传 kind=video、totalDurationSeconds，并按“每段至少 4 秒”拆镜头：5 秒=1 个，10 秒最多 2 个。不要把 5 秒拆成 3-4 个镜头。按客户素材和交付要求传 consistency：有实拍且要求还原用 strict，普通创意片用 adaptive，只要草稿用 loose。",
        schema: createStoryboardSchema,
      },
    ),
    tool(
      async (input) => {
        try {
          const { storyboardId, canonAssetId, consistency, ...patch } = input;
          const repo = await getStoryboardsRepository();
          const detail = await repo.updateStoryboard(context.projectId, storyboardId, {
            ...patch,
            ...(consistency ? { metadata: { consistency } } : {}),
          });
          const storyboard =
            canonAssetId !== undefined
              ? await repo.setCanonAsset(context.projectId, storyboardId, canonAssetId)
              : detail.storyboard;
          return JSON.stringify({
            storyboard_id: storyboard.id,
            title: storyboard.title,
            kind: storyboard.kind,
            status: storyboard.status,
            active: storyboard.active,
            canon_asset_id: storyboard.canonAssetId ?? null,
            total_duration_seconds: storyboard.totalDurationSeconds ?? null,
            consistency: readConsistencyPolicy(storyboard),
          });
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : "更新分镜失败",
          });
        }
      },
      {
        name: "update_storyboard",
        description:
          "改分镜标题、brief、kind、画幅、风格、canon 设定图、总时长、状态或 active。只传要改的字段；canonAssetId=null 清空设定图。",
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

  // 没配 Pexels key 时不把工具交给模型：否则模型会反复调用并连续失败，打断对话。
  return env.pexelsApiKey
    ? tools
    : tools.filter((item) => item.name !== "search_inspiration");
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