"use client";

import { ImageOff, Loader2, X } from "lucide-react";
import type { ImageAttachment } from "@/hooks/use-image-attachments";
import type { ChatAttachment } from "@/lib/api";
import { setChatImageDragData } from "@/lib/chat-canvas-drag";

function AttachmentBarItem({
  attachment,
  onRemove,
}: {
  attachment: ImageAttachment;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="group relative size-14 shrink-0 overflow-hidden rounded-lg border border-line bg-canvas">
      {attachment.status === "reading" ? (
        <div className="grid h-full place-items-center">
          <Loader2 className="size-4 animate-spin text-faint" strokeWidth={1.75} />
        </div>
      ) : attachment.status === "error" ? (
        <div
          className="grid h-full place-items-center px-1 text-center"
          title={attachment.error}
        >
          <ImageOff className="size-4 text-danger" strokeWidth={1.5} />
        </div>
      ) : (
        <img
          src={attachment.url}
          alt={attachment.name}
          title={attachment.name}
          draggable
          onDragStart={(event) =>
            setChatImageDragData(event, {
              url: attachment.url,
              title: attachment.name,
              mimeType: attachment.mimeType,
            })
          }
          className="h-full w-full cursor-grab object-cover active:cursor-grabbing"
        />
      )}

      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        aria-label={`移除 ${attachment.name}`}
        className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-ink text-white opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <X className="size-2.5" strokeWidth={2.5} />
      </button>
    </div>
  );
}

export function AttachmentBar({
  attachments,
  onRemove,
}: {
  attachments: ImageAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex gap-2 overflow-x-auto px-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {attachments.map((attachment) => (
        <AttachmentBarItem
          key={attachment.id}
          attachment={attachment}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

export function MessageAttachments({
  attachments,
  onPreview,
}: {
  attachments: ChatAttachment[];
  onPreview: (attachment: ChatAttachment) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((attachment) => (
        <button
          key={attachment.id}
          type="button"
          onClick={() => onPreview(attachment)}
          aria-label={`查看 ${attachment.name}`}
          className="group relative overflow-hidden rounded-lg border border-line"
        >
          <img
            src={attachment.url}
            alt={attachment.name}
            title={attachment.name}
            draggable
            onDragStart={(event) =>
              setChatImageDragData(event, {
                url: attachment.url,
                title: attachment.name,
                mimeType: attachment.mimeType,
              })
            }
            className="size-20 cursor-grab object-cover transition-opacity group-hover:opacity-90 active:cursor-grabbing"
          />
        </button>
      ))}
    </div>
  );
}