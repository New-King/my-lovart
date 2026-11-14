import type { ChatAttachment } from "@my-lovart/shared";
import { fileDataUrlFromUrl } from "../files/file.store.js";

export type AgentAttachmentContext = {
  /** assetId → 可直接给 provider 的地址（data URL 或公网 URL） */
  map: Record<string, string>;
  /** 注入给模型的 XML，只描述可用素材，不塞 base64 */
  xml: string;
};

export function buildAttachmentContext(attachments: ChatAttachment[]): AgentAttachmentContext {
  const map: Record<string, string> = {};
  const lines: string[] = [];

  attachments.forEach((attachment, index) => {
    if (!attachment.mimeType.startsWith("image/")) return;

    const assetId = `asset-${index + 1}`;
    const resolved = resolveReference(attachment.url);
    if (!resolved) return;

    map[assetId] = resolved;
    lines.push(
      `  <image index="${index + 1}" asset_id="${assetId}" mime_type="${escapeXml(attachment.mimeType)}" name="${escapeXml(attachment.name)}" />`,
    );
  });

  return {
    map,
    xml:
      lines.length > 0
        ? `<input_images count="${lines.length}">\n${lines.join("\n")}\n</input_images>`
        : "",
  };
}

function resolveReference(url: string): string | undefined {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    // 本地 /files 地址要转成 data URL，供应商访问不到 127.0.0.1
    return fileDataUrlFromUrl(url) ?? url;
  }
  return fileDataUrlFromUrl(url);
}

/** 画布摘要：位置、尺寸、标题，并给每张图一个可给工具用的 asset_id */
export function buildCanvasContext(
  elements: unknown[],
  files: Record<string, unknown>,
): { summary: string; map: Record<string, string>; xml: string } {
  const images = elements.filter(
    (element): element is Record<string, unknown> =>
      typeof element === "object" &&
      element !== null &&
      (element as { type?: unknown }).type === "image" &&
      !(element as { isDeleted?: unknown }).isDeleted,
  );

  if (images.length === 0) {
    return { summary: "画布目前为空。", map: {}, xml: "" };
  }

  const map: Record<string, string> = {};
  const lines: string[] = [];
  const xmlLines: string[] = [];

  images.slice(0, 20).forEach((element, index) => {
    const x = Math.round(Number(element.x) || 0);
    const y = Math.round(Number(element.y) || 0);
    const width = Math.round(Number(element.width) || 0);
    const height = Math.round(Number(element.height) || 0);
    const custom = element.customData as { name?: unknown } | undefined;
    const name = typeof custom?.name === "string" ? custom.name.slice(0, 40) : "图片";
    const assetId = `canvas-${index + 1}`;

    const fileId = typeof element.fileId === "string" ? element.fileId : "";
    const file = files[fileId] as { dataURL?: unknown; mimeType?: unknown } | undefined;
    if (typeof file?.dataURL === "string") {
      map[assetId] = file.dataURL;
    }

    lines.push(`- [${assetId}] ${name} @ (${x}, ${y}) ${width}×${height}`);
    xmlLines.push(
      `  <image asset_id="${assetId}" name="${escapeXml(name)}" x="${x}" y="${y}" width="${width}" height="${height}" />`,
    );
  });

  return {
    summary: `画布上有 ${images.length} 张图片：\n${lines.join("\n")}`,
    map,
    xml: `<canvas_images count="${images.length}">\n${xmlLines.join("\n")}\n</canvas_images>`,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}