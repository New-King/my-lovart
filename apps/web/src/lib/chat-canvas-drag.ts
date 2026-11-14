import type { DragEvent } from "react";

export const CHAT_IMAGE_DRAG_TYPE = "application/x-mylovart-chat-image";

export type ChatImageDragPayload = {
  url: string;
  title?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  batchId?: string;
};

const payloads = new Map<string, ChatImageDragPayload>();

export function isChatImageDragEvent(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(CHAT_IMAGE_DRAG_TYPE);
}

export function setChatImageDragData(event: DragEvent, payload: ChatImageDragPayload): void {
  const id = crypto.randomUUID();
  payloads.set(id, payload);

  event.dataTransfer.setData(CHAT_IMAGE_DRAG_TYPE, id);
  // data URL 可能很大，不塞进 dataTransfer；自定义类型里只放短 id。
  if (!payload.url.startsWith("data:") && payload.url.length < 2000) {
    event.dataTransfer.setData("text/uri-list", payload.url);
  }
  event.dataTransfer.effectAllowed = "copy";

  window.setTimeout(() => payloads.delete(id), 30_000);
}

export function parseChatImageDragData(dataTransfer: DataTransfer): ChatImageDragPayload | null {
  const id = dataTransfer.getData(CHAT_IMAGE_DRAG_TYPE);
  if (id) {
    const payload = payloads.get(id);
    if (payload) {
      payloads.delete(id);
      return payload;
    }
  }

  const url = (dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain")).trim();
  if (url && /^(https?:|data:image\/)/i.test(url)) return { url };

  return null;
}

export function guessMimeTypeFromUrl(url: string): string {
  const lower = url.split("?")[0]?.toLowerCase() ?? "";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
}