"use client";

import { ArrowUp, ChevronDown, ImagePlus, Plus, Square } from "lucide-react";
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
import type { AspectRatio, ChatAttachment } from "@/lib/api";
import type { ReferenceItem } from "@/lib/chat-references";
import type { LibraryMaterial } from "@/lib/public-materials";
import { AttachmentBar } from "./chat-attachments";

export type ChatComposerHandle = {
  openFilePicker: () => void;
  addMaterial: (material: LibraryMaterial) => void;
};

type Props = {
  disabled: boolean;
  sending: boolean;
  error: string | null;
  placeholder: string;
  projectImages: ReferenceItem[];
  onOpenMaterials: () => void;
  onSend: (
    text: string,
    attachments: ChatAttachment[],
    aspectRatio: AspectRatio,
  ) => Promise<boolean>;
  onStop: () => void;
};

const RATIOS: { value: AspectRatio; label: string }[] = [
  { value: "1:1", label: "1:1 方形" },
  { value: "4:3", label: "4:3 横版" },
  { value: "3:4", label: "3:4 竖版" },
  { value: "16:9", label: "16:9 宽屏" },
  { value: "9:16", label: "9:16 竖屏" },
];

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
  { disabled, sending, error, placeholder, projectImages, onOpenMaterials, onSend, onStop },
  ref,
) {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [ratioMenuOpen, setRatioMenuOpen] = useState(false);
  const [aspect, setAspect] = useState<AspectRatio>("3:4");
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
    setRatioMenuOpen(false);
    setMentionQuery(null);

    const value = text.trim();
    const snapshot = attachments;
    const images = readyAttachments;
    setText("");
    clearAll();

    let ok = false;
    try {
      ok = await onSend(value, images, aspect);
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
      className="relative shrink-0 border-t border-line p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:pb-3"
      onKeyDown={(event) => event.stopPropagation()}
    >
      {error && <p className="mb-2 px-1 text-[11px] text-danger">{error}</p>}

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

        {ratioMenuOpen && (
          <>
            <button
              type="button"
              aria-label="关闭比例菜单"
              onClick={() => setRatioMenuOpen(false)}
              className="fixed inset-0 z-20 cursor-default"
            />
            <div className="absolute bottom-10 left-11 z-30 w-32 overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-[0_18px_60px_-24px_rgba(24,24,27,0.4)]">
              <p className="px-2 pb-1 pt-1 font-mono text-[9px] tracking-[0.16em] text-faint">
                画面比例
              </p>
              {RATIOS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setAspect(option.value);
                    setRatioMenuOpen(false);
                    textareaRef.current?.focus();
                  }}
                  className={`flex h-8 w-full items-center justify-between rounded-lg px-2 text-[12px] transition-colors hover:bg-canvas ${
                    option.value === aspect ? "text-ink" : "text-muted"
                  }`}
                >
                  <span>{option.label}</span>
                  {option.value === aspect && <span className="text-[10px] text-faint">当前</span>}
                </button>
              ))}
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
            {!sending && (
              <button
                type="button"
                onClick={() => setRatioMenuOpen((value) => !value)}
                disabled={disabled}
                aria-label={`画面比例 ${aspect}`}
                title="画面比例"
                className="inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-[10.5px] text-muted transition-colors hover:bg-canvas hover:text-ink disabled:opacity-40"
              >
                {aspect}
                <ChevronDown className="size-3" strokeWidth={2} />
              </button>
            )}
            <span className="hidden text-[10.5px] text-faint sm:inline">支持拖拽 / 粘贴</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden text-[10.5px] text-faint sm:inline">
              {sending ? "生成中" : "⏎ 发送"}
            </span>
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