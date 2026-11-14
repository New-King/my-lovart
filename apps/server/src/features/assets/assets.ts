import type { ChatMessage, ImageBlock, VideoBlock } from "@my-lovart/shared";

export type ProjectAsset = {
  id: string;
  projectId: string;
  kind: "image" | "video";
  origin: "generated" | "uploaded" | "derived";
  title: string;
  prompt: string;
  model?: string;
  provider?: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds?: number;
  aspectRatio?: string;
  parentAssetId?: string;
  sourceAssetIds: string[];
  canvasElementId?: string;
  messageId?: string;
  shotId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ProjectAssetBrief = {
  id: string;
  kind: "image" | "video";
  title: string;
  prompt: string;
  model?: string;
  width: number;
  height: number;
  durationSeconds?: number;
  shotId?: string;
  createdAt: string;
};

export function toAssetBrief(asset: ProjectAsset): ProjectAssetBrief {
  return {
    id: asset.id,
    kind: asset.kind,
    title: asset.title,
    prompt: asset.prompt,
    ...(asset.model ? { model: asset.model } : {}),
    width: asset.width,
    height: asset.height,
    ...(asset.durationSeconds ? { durationSeconds: asset.durationSeconds } : {}),
    ...(asset.shotId ? { shotId: asset.shotId } : {}),
    createdAt: asset.createdAt,
  };
}

/**
 * 兼容 0003 之前已经产生的消息：从 blocks/parts 里还原资产。
 * 这些记录没有血缘，但至少 title/prompt/尺寸还在，先让上下文有东西可用。
 */
export function collectLegacyAssets(messages: ChatMessage[]): ProjectAsset[] {
  const seen = new Set<string>();
  const assets: ProjectAsset[] = [];

  const push = (
    block: ImageBlock | VideoBlock,
    message: ChatMessage,
  ) => {
    if (seen.has(block.id)) return;
    seen.add(block.id);
    assets.push({
      id: block.id,
      projectId: "",
      kind: block.type === "video" ? "video" : "image",
      origin: "generated",
      title:
        block.title?.trim() ||
        block.prompt?.trim().slice(0, 40) ||
        (block.type === "video" ? "未命名视频" : "未命名图片"),
      prompt: block.prompt ?? "",
      ...(block.model ? { model: block.model } : {}),
      url: block.url,
      mimeType: block.mimeType,
      width: block.width,
      height: block.height,
      ...(block.type === "video" && block.durationSeconds
        ? { durationSeconds: block.durationSeconds }
        : {}),
      ...(block.type === "image" && block.aspectRatio
        ? { aspectRatio: block.aspectRatio }
        : {}),
      sourceAssetIds: block.sourceAssetIds ?? [],
      messageId: message.id,
      metadata: { legacy: true },
      createdAt: message.createdAt,
    });
  };

  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === "image" || block.type === "video") push(block, message);
    }
    for (const part of message.parts ?? []) {
      if (part.type === "block" && (part.block.type === "image" || part.block.type === "video")) {
        push(part.block, message);
      }
    }
  }

  return assets.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function mergeAssets(
  primary: ProjectAsset[],
  legacy: ProjectAsset[],
): ProjectAsset[] {
  const map = new Map<string, ProjectAsset>();
  for (const asset of legacy) map.set(asset.id, asset);
  for (const asset of primary) map.set(asset.id, asset);
  return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}