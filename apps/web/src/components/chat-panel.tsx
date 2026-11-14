"use client";

import type {
  ChatBlock,
  ImageBlock,
  MessagePart,
  ToolBlock,
} from "@my-lovart/shared";
import { ArrowDown, Copy, Frame, Menu, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getHealth,
  type ChatAttachment,
  type ChatMessage,
  type Project,
} from "@/lib/api";
import type { ReferenceItem } from "@/lib/chat-references";
import { MessageAttachments } from "./chat-attachments";
import { ChatBlocks } from "./chat-blocks";
import { ChatComposer, type ChatComposerHandle } from "./chat-composer";
import { ChatEmptyState } from "./chat-empty-state";
import { ImageLightbox } from "./image-lightbox";
import { MediaSkeleton } from "./media-skeleton";
import { RunProcess } from "./run-process";
import { useToast } from "./ui/toast";

type Props = {
  project: Project | null;
  messages: ChatMessage[];
  loading: boolean;
  loadingError: string | null;
  onReload: () => void;
  sending: boolean;
  onCreate: () => void;
  onSend: (
    text: string,
    attachments: ChatAttachment[],
  ) => Promise<boolean>;
  /** 点快捷选项：直接把选项原话发出去，不额外带画幅 */
  onQuickReply: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onAddToCanvas: (block: ImageBlock) => void;
  onOpenMaterials: () => void;
  onOpenProjects: () => void;
  onShowCanvas: () => void;
  composerRef: RefObject<ChatComposerHandle | null>;
};

function CopyButton({ text }: { text: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      aria-label="复制内容"
      title="复制"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => toast("success", "已复制"))
          .catch(() => toast("error", "复制失败，请手动选择"));
      }}
      className="grid size-6 place-items-center rounded-md text-faint opacity-60 transition-all hover:bg-surface hover:text-ink focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
    >
      <Copy className="size-3" strokeWidth={1.75} />
    </button>
  );
}

function ActiveMediaSkeleton({ message }: { message: ChatMessage }) {
  const tool = message.blocks?.find(
    (block): block is ToolBlock =>
      block.type === "tool" &&
      (block.tool === "generate_image" || block.tool === "generate_video") &&
      (block.status === "running" || block.status === "queued"),
  );
  if (!tool) return null;

  return (
    <MediaSkeleton
      kind={tool.tool === "generate_video" ? "video" : "image"}
      {...(tool.aspectRatio ? { aspectRatio: tool.aspectRatio } : {})}
    />
  );
}

type PartUnit =
  | { kind: "text"; key: string; text: string; cursor: boolean }
  | { kind: "blocks"; key: string; blocks: ChatBlock[] };

/** 文字和产物按到达顺序排；相邻且同批次的媒体合成一行 */
function groupMessageParts(parts: MessagePart[], streaming: boolean): PartUnit[] {
  const units: PartUnit[] = [];
  const pushText = (text: string) => {
    const last = units[units.length - 1];
    if (last?.kind === "text") {
      last.text += text;
      return;
    }
    units.push({ kind: "text", key: `text-${units.length}`, text, cursor: false });
  };

  for (const part of parts) {
    if (part.type === "text") {
      pushText(part.text);
      continue;
    }

    const block = part.block;
    if (block.type === "tool") continue;

    const last = units[units.length - 1];
    const batch = "batchId" in block ? block.batchId : undefined;
    const lastBlock =
      last?.kind === "blocks" ? last.blocks[last.blocks.length - 1] : undefined;
    const lastBatch =
      lastBlock && "batchId" in lastBlock ? lastBlock.batchId : undefined;

    if (
      last?.kind === "blocks" &&
      batch &&
      lastBatch === batch &&
      (block.type === "image" || block.type === "video")
    ) {
      last.blocks.push(block);
    } else {
      units.push({ kind: "blocks", key: `blocks-${units.length}`, blocks: [block] });
    }
  }

  if (streaming) {
    const last = units[units.length - 1];
    if (last?.kind === "text") last.cursor = true;
  }

  return units;
}

export function ChatPanel({
  project,
  messages,
  loading,
  loadingError,
  onReload,
  sending,
  onCreate,
  onSend,
  onQuickReply,
  onStop,
  onRetry,
  onAddToCanvas,
  onOpenMaterials,
  onOpenProjects,
  onShowCanvas,
  composerRef,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  const [generation, setGeneration] = useState<"mock" | "real" | null>(null);

  useEffect(() => {
    getHealth()
      .then((health) => setGeneration(health.generation))
      .catch(() => {});
  }, []);

  const lastMessage = messages[messages.length - 1];
  const lastContentLength = lastMessage?.content.length ?? 0;
  const lastBlockCount = lastMessage?.blocks?.length ?? 0;
  const lastUpdatedAt = lastMessage?.updatedAt ?? "";

  const scrollToBottom = (smooth: boolean) => {
    const list = listRef.current;
    if (!list) return;
    nearBottomRef.current = true;
    setShowJump(false);
    window.requestAnimationFrame(() => {
      list.scrollTo({ top: list.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    });
  };

  // 切换项目时重置贴底状态，等 DOM 画完再滚，避免停在顶部
  useEffect(() => {
    nearBottomRef.current = true;
    setShowJump(false);
    const timer = window.setTimeout(() => scrollToBottom(false), 0);
    return () => window.clearTimeout(timer);
  }, [project?.id]);

  useEffect(() => {
    if (loading) return;
    scrollToBottom(false);
  }, [loading]);

  useEffect(() => {
    if (!nearBottomRef.current) {
      setShowJump(true);
      return;
    }
    scrollToBottom(true);
  }, [messages.length, sending, lastContentLength, lastBlockCount, lastUpdatedAt]);

  const projectImages = useMemo(() => {
    const seen = new Set<string>();
    const items: ReferenceItem[] = [];

    const push = (item: ReferenceItem) => {
      if (items.length >= 24 || seen.has(item.url)) return;
      seen.add(item.url);
      items.push(item);
    };

    for (const message of messages) {
      for (const attachment of message.attachments ?? []) {
        push({
          id: attachment.id,
          name: attachment.name,
          url: attachment.url,
          mimeType: attachment.mimeType,
        });
      }
      for (const block of message.blocks ?? []) {
        if (block.type === "image") {
          push({
            id: block.id,
            name: block.prompt || "生成图像",
            url: block.url,
            mimeType: block.mimeType,
            width: block.width,
            height: block.height,
          });
        }
      }
    }

    return items.reverse();
  }, [messages]);

  const agentLabel = generation === "real" ? "seedream · h3" : generation === "mock" ? "mock-agent" : "agent";

  return (
    <section className="flex w-full shrink-0 flex-col bg-canvas lg:w-[380px] lg:border-l lg:border-line">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3 lg:px-4">
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={onOpenProjects}
            aria-label="打开项目"
            className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink lg:hidden"
          >
            <Menu className="size-4" strokeWidth={1.75} />
          </button>
          <span className="text-[13px] font-medium tracking-tight">对话</span>
          {sending && (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">
              <span className="size-1 animate-pulse rounded-full bg-accent" />
              生成中
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onShowCanvas}
            aria-label="打开画布"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] text-muted transition-colors hover:bg-surface hover:text-ink lg:hidden"
          >
            <Frame className="size-3.5" strokeWidth={1.75} />
            画布
          </button>
          <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] text-muted">
            {agentLabel}
          </span>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={() => {
            const list = listRef.current;
            if (!list) return;
            const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
            nearBottomRef.current = near;
            setShowJump(!near);
          }}
          className="h-full overflow-y-auto px-4 py-5"
        >
          {loading ? (
            <div className="space-y-3">
              <div className="h-3 w-24 animate-pulse rounded-full bg-line/70" />
              <div className="h-16 w-3/4 animate-pulse rounded-xl bg-line/50" />
              <div className="h-3 w-16 animate-pulse rounded-full bg-line/70" />
              <div className="h-10 w-2/3 animate-pulse rounded-xl bg-line/50" />
            </div>
          ) : loadingError ? (
            <div className="flex min-h-full flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="text-[13px] text-ink">对话加载失败</p>
              <p className="max-w-[280px] break-words text-[11.5px] leading-relaxed text-faint">
                {loadingError}
              </p>
              <button
                type="button"
                onClick={onReload}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12px] text-ink transition-colors hover:bg-canvas"
              >
                <RotateCcw className="size-3.5" strokeWidth={1.75} />
                重试
              </button>
            </div>
          ) : messages.length === 0 ? (
            <ChatEmptyState
              hasProject={Boolean(project)}
              disabled={sending}
              onCreate={onCreate}
              onUpload={() => composerRef.current?.openFilePicker()}
              onPickStarter={(text) => composerRef.current?.setText(text)}
            />
          ) : (
            <div className="space-y-5">
              {messages.map((message, index) =>
                message.role === "user" ? (
                  <div key={message.id} className="group flex flex-col items-end gap-1">
                    <div className="max-w-[85%] rounded-xl border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed">
                      {message.attachments && message.attachments.length > 0 && (
                        <div className={message.content ? "mb-2" : ""}>
                          <MessageAttachments
                            attachments={message.attachments}
                            onPreview={(attachment) =>
                              setPreview({ src: attachment.url, name: attachment.name })
                            }
                          />
                        </div>
                      )}
                      {message.content && (
                        <p className="whitespace-pre-wrap break-words">{message.content}</p>
                      )}
                    </div>
                    {message.content && (
                      <div className="flex justify-end pr-0.5">
                        <CopyButton text={message.content} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div key={message.id} className="group space-y-2">
                    <RunProcess message={message} />

                    {message.parts && message.parts.length > 0 ? (
                      <div className="space-y-3">
                        {groupMessageParts(
                          message.parts,
                          message.status === "streaming",
                        ).map((unit) =>
                          unit.kind === "text" ? (
                            <div
                              key={unit.key}
                              className="prose-muse text-[13.5px] leading-[1.7] text-ink"
                            >
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {unit.text}
                              </ReactMarkdown>
                              {unit.cursor && (
                                <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-ink/40 align-middle" />
                              )}
                            </div>
                          ) : (
                            <ChatBlocks
                              key={unit.key}
                              blocks={unit.blocks}
                              onPreview={setPreview}
                              onAddToCanvas={onAddToCanvas}
                              onAddReference={(item) =>
                                composerRef.current?.addReference(item)
                              }
                            />
                          ),
                        )}
                      </div>
                    ) : (
                      <>
                        {message.content && (
                          <div className="prose-muse text-[13.5px] leading-[1.7] text-ink">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {message.content}
                            </ReactMarkdown>
                            {message.status === "streaming" && (
                              <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-ink/40 align-middle" />
                            )}
                          </div>
                        )}

                        {message.blocks && message.blocks.length > 0 && (
                          <ChatBlocks
                            blocks={message.blocks}
                            onPreview={setPreview}
                            onAddToCanvas={onAddToCanvas}
                            onAddReference={(item) => composerRef.current?.addReference(item)}
                          />
                        )}
                      </>
                    )}

                    <ActiveMediaSkeleton message={message} />

                    {message.options &&
                      message.options.length > 0 &&
                      index === messages.length - 1 &&
                      message.status !== "streaming" &&
                      message.status !== "queued" && (
                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                          {message.options.map((option) => (
                            <button
                              key={option}
                              type="button"
                              onClick={() => onQuickReply(option)}
                              disabled={sending}
                              className="max-w-full rounded-full border border-line bg-surface px-3 py-1.5 text-left text-[11.5px] leading-snug text-ink transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {option}
                            </button>
                          ))}
                          <p className="basis-full pt-0.5 text-[10px] text-faint">
                            也可以直接输入其他答案。
                          </p>
                        </div>
                      )}

                    {message.status === "failed" && (
                      <div className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/5 px-2.5 py-2 text-[11.5px] text-danger">
                        <div className="min-w-0 flex-1">
                          <p className="break-words">{message.error || "生成失败"}</p>
                          {message.failure?.code && (
                            <p className="mt-0.5 font-mono text-[9px] opacity-70">
                              {message.failure.code}
                            </p>
                          )}
                        </div>
                        {message.failure?.retriable !== false && (
                          <button
                            type="button"
                            onClick={onRetry}
                            disabled={sending}
                            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-danger/30 px-1.5 text-[11px] transition-colors hover:bg-danger/10 disabled:opacity-50"
                          >
                            <RotateCcw className="size-3" strokeWidth={2} />
                            重试
                          </button>
                        )}
                      </div>
                    )}

                    {message.status === "canceled" && (
                      <p className="text-[11px] text-faint">已停止生成，保留已产出的部分。</p>
                    )}

                    <div className="flex items-center gap-1">
                      {message.content && <CopyButton text={message.content} />}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        {showJump && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            aria-label="回到底部"
            className="absolute bottom-3 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-line bg-surface text-muted shadow-[0_10px_28px_-14px_rgba(24,24,27,0.35)] transition-colors hover:text-ink"
          >
            <ArrowDown className="size-3.5" strokeWidth={2} />
          </button>
        )}
      </div>

      <ChatComposer
        ref={composerRef}
        key={project?.id ?? "no-project"}
        disabled={!project || loading}
        sending={sending}
        placeholder={
          project
            ? sending
              ? "生成中，可以先写下一条…"
              : "描述你想要的画面，输入 @ 引用项目图片…"
            : "先新建一个项目"
        }
        projectImages={projectImages}
        onOpenMaterials={onOpenMaterials}
        onSend={onSend}
        onStop={onStop}
      />

      {preview && (
        <ImageLightbox
          src={preview.src}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}