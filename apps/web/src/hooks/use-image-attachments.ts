"use client";

import { useCallback, useMemo, useState } from "react";
import type { ChatAttachment } from "@/lib/api";

export type ImageAttachment = ChatAttachment & {
  status: "reading" | "ready" | "error";
  error?: string;
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** 视觉输入预算：长边 1600，超过就重编码；小图保留原文件 */
const MAX_IMAGE_EDGE = 1600;
const KEEP_RAW_BYTES = 1_200_000;
const MAX_DATA_URL_CHARS = 3_000_000;

function dataUrlBytes(url: string): number {
  const comma = url.indexOf(",");
  if (comma < 0) return 0;
  return Math.round(((url.length - comma - 1) * 3) / 4);
}

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("读取失败"));
    reader.onerror = () => reject(reader.error ?? new Error("读取失败"));
    reader.readAsDataURL(file);
  });
}

/**
 * 浏览器侧先缩图：10MB 原图直接 base64 发给服务端会拖慢上传，
 * 也会挤占模型视觉预算。长边 1600 足够识别主体/文字/风格。
 */
export async function prepareImageFile(file: File): Promise<{
  url: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}> {
  if (file.type === "image/gif" || file.size <= KEEP_RAW_BYTES) {
    const url = await readDataUrl(file);
    return { url, mimeType: file.type, size: file.size };
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("图片处理失败");
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
  let url = canvas.toDataURL(mimeType, 0.86);
  if (url.length > MAX_DATA_URL_CHARS) {
    url = canvas.toDataURL("image/jpeg", 0.8);
  }
  return {
    url,
    mimeType: url.startsWith("data:image/png") ? "image/png" : "image/jpeg",
    size: dataUrlBytes(url),
    width,
    height,
  };
}

const toAttachment = (attachment: ImageAttachment): ChatAttachment => ({
  id: attachment.id,
  name: attachment.name,
  mimeType: attachment.mimeType,
  url: attachment.url,
  size: attachment.size,
});

export function useImageAttachments() {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);

  const addFiles = useCallback((files: File[]) => {
    for (const file of files) {
      const id = crypto.randomUUID();
      const name = file.name || "粘贴的图片";

      if (!ALLOWED_TYPES.has(file.type)) {
        setAttachments((prev) => [
          ...prev,
          {
            id,
            name,
            mimeType: file.type || "unknown",
            url: "",
            size: file.size,
            status: "error",
            error: "仅支持 PNG、JPG、WebP、GIF",
          },
        ]);
        continue;
      }

      if (file.size > MAX_FILE_BYTES) {
        setAttachments((prev) => [
          ...prev,
          {
            id,
            name,
            mimeType: file.type,
            url: "",
            size: file.size,
            status: "error",
            error: "图片不能超过 10MB",
          },
        ]);
        continue;
      }

      setAttachments((prev) => [
        ...prev,
        { id, name, mimeType: file.type, url: "", size: file.size, status: "reading" },
      ]);

      void prepareImageFile(file)
        .then((prepared) => {
          setAttachments((prev) =>
            prev.map((item) =>
              item.id === id
                ? {
                    ...item,
                    ...prepared,
                    status: "ready",
                  }
                : item,
            ),
          );
        })
        .catch((err: unknown) => {
          setAttachments((prev) =>
            prev.map((item) =>
              item.id === id
                ? {
                    ...item,
                    status: "error",
                    error: err instanceof Error ? err.message : "读取失败，请重试",
                  }
                : item,
            ),
          );
        });
    }
  }, []);

  const addReference = useCallback((ref: { url: string; name: string; mimeType: string }) => {
    setAttachments((prev) => {
      if (prev.some((item) => item.url === ref.url)) return prev;
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          name: ref.name,
          mimeType: ref.mimeType,
          url: ref.url,
          size: 0,
          status: "ready",
        },
      ];
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearAll = useCallback(() => setAttachments([]), []);

  const restore = useCallback((items: ImageAttachment[]) => setAttachments(items), []);

  const readyAttachments = useMemo(
    () =>
      attachments
        .filter((item) => item.status === "ready" && item.url)
        .map(toAttachment),
    [attachments],
  );

  const isReading = attachments.some((item) => item.status === "reading");

  return {
    attachments,
    addFiles,
    addReference,
    removeAttachment,
    clearAll,
    restore,
    readyAttachments,
    isReading,
  };
}