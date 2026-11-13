"use client";

import { useCallback, useMemo, useState } from "react";
import type { ChatAttachment } from "@/lib/api";

export type ImageAttachment = ChatAttachment & {
  status: "reading" | "ready" | "error";
  error?: string;
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

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

      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        setAttachments((prev) =>
          prev.map((item) =>
            item.id === id
              ? url
                ? { ...item, url, status: "ready" }
                : { ...item, status: "error", error: "读取失败，请重试" }
              : item,
          ),
        );
      };
      reader.onerror = () => {
        setAttachments((prev) =>
          prev.map((item) =>
            item.id === id ? { ...item, status: "error", error: "读取失败，请重试" } : item,
          ),
        );
      };
      reader.readAsDataURL(file);
    }
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
    removeAttachment,
    clearAll,
    restore,
    readyAttachments,
    isReading,
  };
}