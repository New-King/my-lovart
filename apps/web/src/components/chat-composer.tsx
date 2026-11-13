"use client";

import { ArrowUp, ImagePlus } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import type { ChatAttachment } from "@/lib/api";
import { AttachmentBar } from "./chat-attachments";

type Props = {
  disabled: boolean;
  sending: boolean;
  error: string | null;
  placeholder: string;
  onSend: (text: string, attachments: ChatAttachment[]) => Promise<boolean>;
};

function hasFilePayload(event: DragEvent) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export function ChatComposer({ disabled, sending, error, placeholder, onSend }: Props) {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const {
    attachments,
    addFiles,
    removeAttachment,
    clearAll,
    restore,
    readyAttachments,
    isReading,
  } = useImageAttachments();

  const busy = disabled || sending || isReading;
  const canSend = !busy && (text.trim().length > 0 || readyAttachments.length > 0);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 160 ? "auto" : "hidden";
  }, [text]);

  async function submit() {
    if (!canSend) return;

    const value = text.trim();
    const snapshot = attachments;
    const images = readyAttachments;
    setText("");
    clearAll();

    let ok = false;
    try {
      ok = await onSend(value, images);
    } catch {
      ok = false;
    }

    if (!ok) {
      setText(value);
      restore(snapshot);
      textareaRef.current?.focus();
    }
  }

  function handleFiles(files: File[]) {
    if (files.length === 0) return;
    addFiles(files);
    textareaRef.current?.focus();
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (files) handleFiles(Array.from(files));
    event.target.value = "";
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (files.length === 0) return;
    event.preventDefault();
    handleFiles(files);
  }

  function handleDragEnter(event: DragEvent) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function handleDragOver(event: DragEvent) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    handleFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <div
      className="shrink-0 border-t border-line p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:pb-3"
      onKeyDown={(event) => event.stopPropagation()}
    >
      {error && <p className="mb-2 px-1 text-[11px] text-danger">{error}</p>}

      <div
        className="relative rounded-xl border border-line bg-surface transition-[border-color,box-shadow] focus-within:border-accent/40 focus-within:ring-2 focus-within:ring-accent/10"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

        <AttachmentBar attachments={attachments} onRemove={removeAttachment} />

        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          className="block min-h-[52px] w-full resize-none bg-transparent px-3 pb-1 pt-3 text-base leading-relaxed outline-none placeholder:text-faint disabled:opacity-60 lg:text-[13px]"
        />

        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              title="添加参考图片"
              aria-label="添加参考图片"
              className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink disabled:opacity-40 lg:size-7"
            >
              <ImagePlus className="size-4" strokeWidth={1.75} />
            </button>
            <span className="text-[10.5px] text-faint">支持拖拽 / 粘贴</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden text-[10.5px] text-faint sm:inline">⏎ 发送</span>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label="发送"
              className="grid size-8 place-items-center rounded-lg bg-accent text-white transition-opacity hover:opacity-90 disabled:opacity-40 lg:size-7"
            >
              <ArrowUp className="size-3.5" strokeWidth={2.25} />
            </button>
          </div>
        </div>

        {dragging && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl border border-dashed border-accent/40 bg-surface/90">
            <span className="text-[12px] text-muted">松开添加图片</span>
          </div>
        )}
      </div>
    </div>
  );
}