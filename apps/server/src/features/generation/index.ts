import { env } from "../../lib/env.js";
import { registerAllProviders } from "./providers/register-all.js";
import {
  getAvailableImageModels,
  getAvailableVideoModels,
  getImageProvider,
  getVideoProvider,
  resolveImageModelId,
  resolveImageProviderName,
  resolveVideoModelId,
  resolveVideoProviderName,
  type AvailableImageModel,
  type AvailableVideoModel,
} from "./providers/registry.js";
import {
  GenerationError,
  type ImageGenerationInput,
  type ImageGenerationResult,
  type VideoGenerationInput,
  type VideoGenerationResult,
} from "./types.js";

export * from "./types.js";
export type { AvailableImageModel, AvailableVideoModel };
export {
  getAvailableImageModels,
  getAvailableVideoModels,
  registerImageProvider,
  registerVideoProvider,
} from "./providers/registry.js";

export const PREFERRED_IMAGE_MODEL = "doubao-seedream-4-5-251128";

registerAllProviders();

export function resolveDefaultImageModel(): string {
  const models = getAvailableImageModels();
  if (models.length === 0) {
    throw new GenerationError(
      "invalid_config",
      "没有可用的图片渠道，请配置 ARK_API_KEY（或历史变量 VOLCES_API_KEY）",
      false,
    );
  }
  if (env.imageModel && models.some((model) => model.id === env.imageModel)) {
    return env.imageModel;
  }
  if (models.some((model) => model.id === PREFERRED_IMAGE_MODEL)) {
    return PREFERRED_IMAGE_MODEL;
  }
  return models[0]!.id;
}

export function resolveDefaultVideoModel(): string {
  const models = getAvailableVideoModels();
  if (models.length === 0) {
    throw new GenerationError(
      "invalid_config",
      "没有可用的视频渠道，请配置 METASO_API_KEY",
      false,
    );
  }
  if (env.videoModel && models.some((model) => model.id === env.videoModel)) {
    return env.videoModel;
  }
  return models[0]!.id;
}

export async function generateImage(
  input: ImageGenerationInput,
): Promise<ImageGenerationResult> {
  registerAllProviders();
  const requested = input.model?.trim();
  const model = requested ? resolveImageModelId(requested) : resolveDefaultImageModel();
  const providerName = resolveImageProviderName(model, env.imageProvider || undefined);
  const provider = getImageProvider(providerName);
  return provider.generate({
    ...input,
    model,
    quality: input.quality ?? env.imageQuality,
  });
}

export async function generateVideo(
  input: VideoGenerationInput,
): Promise<VideoGenerationResult> {
  registerAllProviders();
  const requested = input.model?.trim();
  const model = requested ? resolveVideoModelId(requested) : resolveDefaultVideoModel();
  const providerName = resolveVideoProviderName(model, env.videoProvider || undefined);
  const provider = getVideoProvider(providerName);
  return provider.generate({
    ...input,
    model,
    resolution: input.resolution ?? env.videoResolution,
  });
}

export type GenerationConfig = {
  defaults: {
    imageProvider: string | null;
    imageModel: string;
    imageQuality: "standard" | "hd" | "ultra";
    imageWatermark: boolean;
    videoProvider: string | null;
    videoModel: string;
    videoResolution: "480p" | "720p" | "1080p";
  };
  imageModels: AvailableImageModel[];
  videoModels: AvailableVideoModel[];
};

/**
 * 给后台/诊断接口用的当前配置。只返回模型元数据，不返回任何 key。
 * 前端或管理端可以据此渲染模型选择器，而不需要硬编码厂商。
 */
export function getGenerationConfig(): GenerationConfig {
  registerAllProviders();
  return {
    defaults: {
      imageProvider: env.imageProvider || null,
      imageModel: resolveDefaultImageModel(),
      imageQuality: env.imageQuality,
      imageWatermark: env.imageWatermark,
      videoProvider: env.videoProvider || null,
      videoModel: resolveDefaultVideoModel(),
      videoResolution: env.videoResolution,
    },
    imageModels: getAvailableImageModels(),
    videoModels: getAvailableVideoModels(),
  };
}