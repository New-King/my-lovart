"use client";

import { ArrowUp, ImagePlus, Plus, Square } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import type { ChatAttachment } from "@/lib/api";
import type { ReferenceItem } from "@/lib/chat-references";
import type { LibraryMaterial } from "@/lib/public-materials";
import { AttachmentBar } from "./chat-attachments";

export type ChatComposerHandle = {
  openFilePicker: () => void;
  addMaterial: (material: LibraryMaterial) => void;
  addReference: (item: { url: string; name: string; mimeType: string }) => void;
  setText: (value: string) => void;
  focus: () => void;
};

type Props = {
  disabled: boolean;
  sending: boolean;
  placeholder: string;
  projectImages: ReferenceItem[];
  onOpenMaterials: () => void;
  onSend: (
    text: string,
    attachments: ChatAttachment[],
  ) => Promise<boolean>;
  onStop: () => void;
};

function hasFilePayload(event: DragEvent) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function ReferenceRow({
  item,
  active,
  onSelect,
}: {
  item: ReferenceItem;
  active: boolean;
  onSelect: (item: ReferenceItem) => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(item)}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
        active ? "bg-canvas" : "hover:bg-canvas"
      }`}
    >
      <img
        src={item.url}
        alt=""
        className="size-7 shrink-0 rounded-md border border-line object-cover"
      />
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{item.name}</span>
      <ImagePlus className="size-3 shrink-0 text-faint" strokeWidth={1.75} />
    </button>
  );
}

export const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer(
  { disabled, sending, placeholder, projectImages, onOpenMaterials, onSend, onStop },
  ref,
) {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const mentionPanelRef = useRef<HTMLDivElement>(null);

  const {
    attachments,
    addFiles,
    addReference,
    removeAttachment,
    clearAll,
    restore,
    readyAttachments,
    isReading,
  } = useImageAttachments();

  const busy = disabled || isReading;
  const mentionOpen = mentionQuery !== null;
  const canSend =
    !busy &&
    !sending &&
    !mentionOpen &&
    (text.trim().length > 0 || readyAttachments.length > 0);
  const canStop = sending && !disabled;
  const query = (mentionQuery ?? "").trim().toLowerCase();
  const projectMatches = projectImages
    .filter((item) => item.name.toLowerCase().includes(query))
    .slice(0, 12);
  const activeIndex = projectMatches.length
    ? Math.min(mentionIndex, projectMatches.length - 1)
    : 0;

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  useImperativeHandle(
    ref,
    () => ({
      openFilePicker() {
        fileInputRef.current?.click();
      },
      addMaterial(material: LibraryMaterial) {
        addReference({
          url: material.url,
          name: material.name,
          mimeType: material.mimeType,
        });
      },
      addReference(item) {
        addReference(item);
      },
      setText(value: string) {
        setText(value);
        setMentionQuery(null);
        window.requestAnimationFrame(() => textareaRef.current?.focus());
      },
      focus() {
        textareaRef.current?.focus();
      },
    }),
    [addReference],
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 160 ? "auto" : "hidden";
  }, [text]);

  useEffect(() => {
    if (!mentionOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (mentionPanelRef.current?.contains(event.target as Node)) return;
      setMentionQuery(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [mentionOpen]);

  async function submit() {
    if (!canSend) return;

    setUploadMenuOpen(false);
    setMentionQuery(null);

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

  function handleTextChange(value: string) {
    setText(value);

    const at = value.lastIndexOf("@");
    if (at < 0 || (at > 0 && !/\s/.test(value[at - 1] ?? ""))) {
      setMentionQuery(null);
      return;
    }

    const nextQuery = value.slice(at + 1);
    if (/\s/.test(nextQuery)) {
      setMentionQuery(null);
      return;
    }

    setMentionQuery(nextQuery);
  }

  function selectReference(item: ReferenceItem) {
    addReference({ url: item.url, name: item.name, mimeType: item.mimeType });
    setText((prev) => prev.replace(/@[^@\s]*$/, "").trimEnd());
    setMentionQuery(null);
    textareaRef.current?.focus();
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

  /** 从画布复制图片时，剪贴板里常常只有 data:image 的 HTML/文本，没有 File */
  async function filesFromDataUrls(source: string): Promise<File[]> {
    const urls = new Set<string>();
    const value = source.trim();

    if (value.startsWith("data:image/")) urls.add(value);
    for (const match of value.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
      if (match[1]?.startsWith("data:image/")) urls.add(match[1]);
    }

    const files: File[] = [];
    for (const url of [...urls].slice(0, 4)) {
      try {
        const blob = await (await fetch(url)).blob();
        if (!blob.type.startsWith("image/")) continue;
        files.push(
          new File([blob], `pasted-image-${files.length + 1}.${blob.type.split("/")[1] ?? "png"}`, {
            type: blob.type,
          }),
        );
      } catch {
        // 单张解析失败就跳过，不影响手动输入
      }
    }
    return files;
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (files.length > 0) {
      event.preventDefault();
      handleFiles(files);
      return;
    }

    // 画布复制出来的图片经常只有 data URL 文本/HTML
    const text = event.clipboardData.getData("text/plain");
    const html = event.clipboardData.getData("text/html");
    const hasDataImage = text.trim().startsWith("data:image/") || /<img[^>]+src=["']data:image\//i.test(html);

    if (hasDataImage) {
      event.preventDefault();
      void filesFromDataUrls(html || text).then((images) => {
        if (images.length > 0) handleFiles(images);
      });
    }
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
      className="relative shrink-0 border-t border-line p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:pb-3"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        className="relative rounded-2xl border border-line bg-surface shadow-[0_10px_32px_-28px_rgba(24,24,27,0.45)] transition-[border-color,box-shadow] focus-within:border-accent/40 focus-within:ring-2 focus-within:ring-accent/10"
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

        {mentionOpen && (
          <div
            ref={mentionPanelRef}
            className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-[0_18px_60px_-24px_rgba(24,24,27,0.4)]"
          >
            {projectMatches.length > 0 ? (
              <>
                <p className="px-2 pb-1 pt-1 font-mono text-[9px] tracking-[0.16em] text-faint">
                  本项目
                </p>
                {projectMatches.map((item, index) => (
                  <ReferenceRow
                    key={item.id}
                    item={item}
                    active={index === activeIndex}
                    onSelect={selectReference}
                  />
                ))}
              </>
            ) : (
              <p className="px-2 py-3 text-center text-[11.5px] text-faint">
                {query ? "没有匹配的项目图片" : "还没有可引用的项目图片"}
              </p>
            )}
          </div>
        )}

        {uploadMenuOpen && (
          <>
            <button
              type="button"
              aria-label="关闭菜单"
              onClick={() => setUploadMenuOpen(false)}
              className="fixed inset-0 z-20 cursor-default"
            />
            <div className="absolute bottom-10 left-0 z-30 w-48 overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-[0_18px_60px_-24px_rgba(24,24,27,0.4)]">
              <button
                type="button"
                onClick={() => {
                  fileInputRef.current?.click();
                  setUploadMenuOpen(false);
                }}
                className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-muted transition-colors hover:bg-canvas hover:text-ink"
              >
                <ImagePlus className="size-4 text-faint" strokeWidth={1.75} />
                上传图片
              </button>
              <button
                type="button"
                onClick={() => {
                  setUploadMenuOpen(false);
                  setMentionQuery(null);
                  onOpenMaterials();
                }}
                className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-muted transition-colors hover:bg-canvas hover:text-ink"
              >
                <ImagePlus className="size-4 text-faint" strokeWidth={1.75} />
                添加素材
              </button>
            </div>
          </>
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(event) => handleTextChange(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();

            if (mentionOpen) {
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionQuery(null);
                return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (projectMatches.length === 0) return;
                setMentionIndex((index) =>
                  event.key === "ArrowDown"
                    ? (index + 1) % projectMatches.length
                    : (index - 1 + projectMatches.length) % projectMatches.length,
                );
                return;
              }
              if (
                (event.key === "Enter" || event.key === "Tab") &&
                projectMatches.length > 0
              ) {
                event.preventDefault();
                const target = projectMatches[activeIndex];
                if (target) selectReference(target);
                return;
              }
            }

            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          className="block min-h-[60px] w-full resize-none bg-transparent px-3 pb-1 pt-3 text-base leading-relaxed outline-none placeholder:text-faint disabled:opacity-60 lg:text-[13px]"
        />

        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setUploadMenuOpen((value) => !value)}
              disabled={disabled}
              title="更多"
              aria-label="更多"
              className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink disabled:opacity-40"
            >
              <Plus className="size-4" strokeWidth={1.75} />
            </button>
          </div>

          <div className="flex items-center gap-2">
            {sending ? (
              <button
                type="button"
                onClick={onStop}
                disabled={!canStop}
                aria-label="停止生成"
                title="停止生成"
                className="grid size-8 place-items-center rounded-full border border-line bg-surface text-ink transition-colors hover:bg-canvas disabled:opacity-40"
              >
                <Square className="size-3 fill-current" strokeWidth={0} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label="发送"
                className="grid size-8 place-items-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <ArrowUp className="size-3.5" strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>

        {dragging && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-2xl border border-dashed border-accent/40 bg-surface/90">
            <span className="text-[12px] text-muted">松开添加图片</span>
          </div>
        )}
      </div>
    </div>
  );
});