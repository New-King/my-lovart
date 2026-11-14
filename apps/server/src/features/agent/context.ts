import type { ChatAttachment } from "@my-lovart/shared";
import { fileDataUrlFromUrl } from "../files/file.store.js";

export type AgentAttachmentContext = {
  /** assetId → 可直接给 provider 的地址（data URL 或公网 URL） */
  map: Record<string, string>;
  /** 注入给模型的 XML，只描述可用素材，不塞 base64 */
  xml: string;
};

export type CanvasElementBrief = {
  id: string;
  /** 给模型看的短别名：canvas-1 / canvas-2 … */
  alias: string;
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CanvasContext = {
  summary: string;
  map: Record<string, string>;
  xml: string;
  /** 供 manipulate_canvas 校验 id，不让模型编造元素 */
  elements: CanvasElementBrief[];
};

const ELEMENT_LIMIT = 60;
const TYPE_LABELS: Record<string, string> = {
  image: "图片",
  text: "文字",
  rectangle: "矩形",
  ellipse: "椭圆",
  diamond: "菱形",
  arrow: "箭头",
  line: "线条",
  frame: "画框",
};

export async function buildAttachmentContext(
  attachments: ChatAttachment[],
): Promise<AgentAttachmentContext> {
  const map: Record<string, string> = {};
  const lines: string[] = [];

  for (const [index, attachment] of attachments.entries()) {
    if (!attachment.mimeType.startsWith("image/")) continue;

    const assetId = `asset-${attachment.id}`;
    const resolved = await resolveReference(attachment.url);
    if (!resolved) continue;

    map[assetId] = resolved;
    lines.push(
      `  <image index="${index + 1}" asset_id="${assetId}" mime_type="${escapeXml(attachment.mimeType)}" name="${escapeXml(attachment.name)}" />`,
    );
  }

  return {
    map,
    xml:
      lines.length > 0
        ? `<input_images count="${lines.length}">\n${lines.join("\n")}\n</input_images>`
        : "",
  };
}

async function resolveReference(url: string): Promise<string | undefined> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    // 本地 /files 地址要转成 data URL，供应商访问不到 127.0.0.1
    return (await fileDataUrlFromUrl(url)) ?? url;
  }
  return fileDataUrlFromUrl(url);
}

/** 画布摘要：位置、尺寸、标题；给每个元素一个短别名，图片额外给可给工具用的 asset_id */
export function buildCanvasContext(
  elements: unknown[],
  files: Record<string, unknown>,
): CanvasContext {
  const briefs: CanvasElementBrief[] = [];

  for (const raw of elements) {
    if (briefs.length >= ELEMENT_LIMIT) break;
    if (typeof raw !== "object" || raw === null) continue;
    const element = raw as Record<string, unknown>;
    if (element.isDeleted === true) continue;
    if (typeof element.id !== "string" || !element.id) continue;
    if (typeof element.type !== "string") continue;

    const x = Math.round(Number(element.x) || 0);
    const y = Math.round(Number(element.y) || 0);
    const width = Math.max(1, Math.round(Number(element.width) || 0));
    const height = Math.max(1, Math.round(Number(element.height) || 0));
    const alias = `canvas-${briefs.length + 1}`;
    const custom = element.customData as { name?: unknown } | undefined;

    let name = TYPE_LABELS[element.type] ?? element.type;
    if (typeof custom?.name === "string" && custom.name.trim()) {
      name = custom.name.trim().slice(0, 40);
    } else if (element.type === "text" && typeof element.text === "string") {
      name = element.text.trim().slice(0, 40) || "文字";
    }

    briefs.push({ id: element.id, alias, type: element.type, name, x, y, width, height });
  }

  if (briefs.length === 0) {
    // 和 Lavart 一样，空画布不注入 <canvas_state>；模型需要时再调用 inspect_canvas，
    // 避免每轮都主动汇报「画布是空的」。
    return { summary: "", map: {}, xml: "", elements: [] };
  }

  const map: Record<string, string> = {};
  const lines: string[] = [];
  const xmlLines: string[] = [];
  let imageCount = 0;

  for (const brief of briefs) {
    const raw = elements.find(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && (item as { id?: unknown }).id === brief.id,
    );
    if (!raw) continue;

    lines.push(
      `- [${brief.alias}] ${brief.type} id=${brief.id} 「${brief.name}」 @ (${brief.x}, ${brief.y}) ${brief.width}×${brief.height}`,
    );

    if (brief.type !== "image") continue;
    imageCount += 1;

    const fileId = typeof raw.fileId === "string" ? raw.fileId : "";
    const file = files[fileId] as { dataURL?: unknown } | undefined;
    if (typeof file?.dataURL === "string") {
      map[brief.alias] = file.dataURL;
    }

    xmlLines.push(
      `  <image asset_id="${brief.alias}" name="${escapeXml(brief.name)}" x="${brief.x}" y="${brief.y}" width="${brief.width}" height="${brief.height}" />`,
    );
  }

  const heading =
    imageCount > 0
      ? `画布上有 ${briefs.length} 个元素（其中 ${imageCount} 张图片）：`
      : `画布上有 ${briefs.length} 个元素（没有图片）：`;

  return {
    summary: `${heading}\n${lines.join("\n")}`,
    map,
    xml:
      xmlLines.length > 0
        ? `<canvas_images count="${xmlLines.length}">\n${xmlLines.join("\n")}\n</canvas_images>`
        : "",
    elements: briefs,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}