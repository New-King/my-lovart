import {
  GenerationError,
  type ImageModelInfo,
  type ImageProvider,
  type VideoModelInfo,
  type VideoProvider,
} from "../types.js";

const imageProviders = new Map<string, ImageProvider>();
const videoProviders = new Map<string, VideoProvider>();

export type AvailableImageModel = ImageModelInfo & { provider: string };
export type AvailableVideoModel = VideoModelInfo & { provider: string };

export function registerImageProvider(provider: ImageProvider): void {
  imageProviders.set(provider.name, provider);
}

export function registerVideoProvider(provider: VideoProvider): void {
  videoProviders.set(provider.name, provider);
}

export function getImageProvider(name: string): ImageProvider {
  const provider = imageProviders.get(name);
  if (!provider) {
    throw new GenerationError(
      "provider_not_found",
      `没有注册图片渠道：${name}`.slice(0, 200),
      false,
    );
  }
  return provider;
}

export function getVideoProvider(name: string): VideoProvider {
  const provider = videoProviders.get(name);
  if (!provider) {
    throw new GenerationError(
      "provider_not_found",
      `没有注册视频渠道：${name}`.slice(0, 200),
      false,
    );
  }
  return provider;
}

export function getAvailableImageModels(): AvailableImageModel[] {
  return [...imageProviders.values()].flatMap((provider) =>
    provider.models.map((model) => ({ ...model, provider: provider.name })),
  );
}

export function getAvailableVideoModels(): AvailableVideoModel[] {
  return [...videoProviders.values()].flatMap((provider) =>
    provider.models.map((model) => ({ ...model, provider: provider.name })),
  );
}

/** 同一个 model id 在多个渠道出现时，优先显式 IMAGE_PROVIDER，否则按注册顺序。 */
export function resolveImageProviderName(
  modelId: string,
  preferredProvider?: string,
): string {
  if (preferredProvider) {
    const provider = getImageProvider(preferredProvider);
    if (!provider.models.some((model) => model.id === modelId)) {
      throw new GenerationError(
        "model_not_found",
        `渠道 ${preferredProvider} 不支持图片模型：${modelId}`.slice(0, 200),
        false,
      );
    }
    return provider.name;
  }

  for (const provider of imageProviders.values()) {
    if (provider.models.some((model) => model.id === modelId)) return provider.name;
  }
  throw new GenerationError(
    "model_not_found",
    `没有图片渠道支持模型：${modelId}`.slice(0, 200),
    false,
  );
}

export function resolveVideoProviderName(
  modelId: string,
  preferredProvider?: string,
): string {
  if (preferredProvider) {
    const provider = getVideoProvider(preferredProvider);
    if (!provider.models.some((model) => model.id === modelId)) {
      throw new GenerationError(
        "model_not_found",
        `渠道 ${preferredProvider} 不支持视频模型：${modelId}`.slice(0, 200),
        false,
      );
    }
    return provider.name;
  }

  for (const provider of videoProviders.values()) {
    if (provider.models.some((model) => model.id === modelId)) return provider.name;
  }
  throw new GenerationError(
    "model_not_found",
    `没有视频渠道支持模型：${modelId}`.slice(0, 200),
    false,
  );
}

/** 支持传 id 或展示名（Agent 可能把用户说的 Seedream 4.5 原样传进来）。 */
export function resolveImageModelId(modelIdOrName: string): string {
  const value = modelIdOrName.trim().toLowerCase();
  for (const provider of imageProviders.values()) {
    const match = provider.models.find(
      (model) =>
        model.id.toLowerCase() === value || model.displayName.toLowerCase() === value,
    );
    if (match) return match.id;
  }
  throw new GenerationError(
    "model_not_found",
    `没有图片渠道支持模型：${modelIdOrName}`.slice(0, 200),
    false,
  );
}

export function resolveVideoModelId(modelIdOrName: string): string {
  const value = modelIdOrName.trim().toLowerCase();
  for (const provider of videoProviders.values()) {
    const match = provider.models.find(
      (model) =>
        model.id.toLowerCase() === value || model.displayName.toLowerCase() === value,
    );
    if (match) return match.id;
  }
  throw new GenerationError(
    "model_not_found",
    `没有视频渠道支持模型：${modelIdOrName}`.slice(0, 200),
    false,
  );
}

/** 只在测试/热切换时使用；业务进程启动后不需要清理。 */
export function clearProviders(): void {
  imageProviders.clear();
  videoProviders.clear();
}