"use client";

import type {
  AspectRatio,
  ChatBlock,
  GenerateRequest,
  ImageBlock,
  InspirationBlock,
  VideoBlock,
} from "@my-lovart/shared";
import {
  Copy,
  Download,
  Frame,
  RotateCcw,
  Search,
} from "lucide-react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { guessMimeTypeFromUrl, setChatImageDragData } from "@/lib/chat-canvas-drag";
import { downloadAsset } from "@/lib/download";
import { useToast } from "./ui/toast";

export type PreviewTarget = { src: string; name: string };

type Props = {
  blocks: ChatBlock[];
  onPreview: (target: PreviewTarget) => void;
  onAddToCanvas: (block: ImageBlock) => void;
  onGenerate: (input: GenerateRequest) => void;
};

const ASPECTS: AspectRatio[] = ["1:1", "4:3", "3:4", "16:9", "9:16"];

function asAspect(value?: string): AspectRatio | undefined {
  return value && (ASPECTS as string[]).includes(value) ? (value as AspectRatio) : undefined;
}

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid size-7 place-items-center rounded-md text-faint transition-colors hover:bg-canvas hover:text-ink"
    >
      {children}
    </button>
  );
}

function ImageCard({
  block,
  onPreview,
  onAddToCanvas,
  onGenerate,
}: {
  block: ImageBlock;
  onPreview: Props["onPreview"];
  onAddToCanvas: Props["onAddToCanvas"];
  onGenerate: Props["onGenerate"];
}) {
  const toast = useToast();
  const label = block.prompt || "生成图像";
  const aspect = asAspect(block.aspectRatio);

  return (
    <figure className="overflow-hidden rounded-xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => onPreview({ src: block.url, name: label })}
        aria-label="查看生成图像"
        className="group relative flex max-h-[360px] w-full items-center justify-center bg-canvas"
      >
        <img
          src={block.url}
          alt={label}
          loading="lazy"
          draggable
          onDragStart={(event) =>
            setChatImageDragData(event, {
              url: block.url,
              title: label,
              mimeType: block.mimeType,
              width: block.width,
              height: block.height,
            })
          }
          className="max-h-[360px] w-auto max-w-full cursor-grab object-contain active:cursor-grabbing"
        />
        <span className="pointer-events-none absolute inset-0 grid place-items-center bg-ink/0 opacity-0 transition-all group-hover:bg-ink/10 group-hover:opacity-100">
          <span className="rounded-full bg-ink/70 px-2.5 py-1 text-[10.5px] text-white">
            查看大图
          </span>
        </span>
      </button>

      <figcaption className="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] text-muted">{label}</p>
          <p className="truncate font-mono text-[9px] tracking-[0.08em] text-faint">
            {block.model} · {block.aspectRatio ?? `${block.width}×${block.height}`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <ActionButton
            label="放入画布"
            onClick={() => onAddToCanvas(block)}
          >
            <Frame className="size-3.5" strokeWidth={1.75} />
          </ActionButton>
          <ActionButton
            label="再生成一版"
            onClick={() =>
              onGenerate({
                kind: "image",
                prompt: block.prompt ?? "再生成一版",
                ...(aspect ? { aspectRatio: aspect } : {}),
              })
            }
          >
            <RotateCcw className="size-3.5" strokeWidth={1.75} />
          </ActionButton>
          <ActionButton
            label="下载图片"
            onClick={() => {
              void downloadAsset(block.url, label).catch(() => toast("error", "下载失败"));
            }}
          >
            <Download className="size-3.5" strokeWidth={1.75} />
          </ActionButton>
          {block.prompt && (
            <ActionButton
              label="复制提示词"
              onClick={() => {
                void navigator.clipboard
                  .writeText(block.prompt ?? "")
                  .then(() => toast("success", "提示词已复制"))
                  .catch(() => toast("error", "复制失败"));
              }}
            >
              <Copy className="size-3.5" strokeWidth={1.75} />
            </ActionButton>
          )}
        </div>
      </figcaption>
    </figure>
  );
}

function VideoCard({
  block,
  onGenerate,
}: {
  block: VideoBlock;
  onGenerate: Props["onGenerate"];
}) {
  const toast = useToast();

  return (
    <figure className="overflow-hidden rounded-xl border border-line bg-surface">
      <video
        controls
        playsInline
        preload="metadata"
        poster={block.posterUrl}
        src={block.url}
        className="aspect-video w-full bg-ink"
      />
      <figcaption className="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] text-muted">{block.prompt || "生成视频"}</p>
          <p className="truncate font-mono text-[9px] tracking-[0.08em] text-faint">
            {block.model} · {block.durationSeconds ?? "?"}s · {block.width}×{block.height}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <ActionButton
            label="再生成一版"
            onClick={() =>
              onGenerate({
                kind: "video",
                prompt: block.prompt ?? "再生成一版",
              })
            }
          >
            <RotateCcw className="size-3.5" strokeWidth={1.75} />
          </ActionButton>
          <ActionButton
            label="下载视频"
            onClick={() => {
              void downloadAsset(block.url, block.prompt || "生成视频");
            }}
          >
            <Download className="size-3.5" strokeWidth={1.75} />
          </ActionButton>
        </div>
      </figcaption>
    </figure>
  );
}

function InspirationCard({
  block,
  onPreview,
}: {
  block: InspirationBlock;
  onPreview: Props["onPreview"];
}) {
  return (
    <section className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <Search className="size-3.5 text-faint" strokeWidth={1.75} />
        <span className="font-mono text-[9px] tracking-[0.16em] text-faint">灵感参考</span>
        <span className="ml-auto text-[10px] text-faint">{block.items.length} 条</span>
      </div>
      <p className="mt-1.5 text-[12px] text-muted">{block.query}</p>

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        {block.items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onPreview({ src: item.imageUrl, name: item.title })}
            aria-label={`查看 ${item.title}`}
            className="group overflow-hidden rounded-lg border border-line bg-canvas text-left"
          >
            <img
              src={item.imageUrl}
              alt={item.title}
              loading="lazy"
              draggable
              onDragStart={(event) =>
                setChatImageDragData(event, {
                  url: item.imageUrl,
                  title: item.title,
                  mimeType: guessMimeTypeFromUrl(item.imageUrl),
                  width: item.width,
                  height: item.height,
                })
              }
              className="aspect-[4/3] w-full cursor-grab object-cover transition-opacity group-hover:opacity-90 active:cursor-grabbing"
            />
            <div className="px-2 py-1.5">
              <p className="truncate text-[11.5px] text-ink">{item.title}</p>
              <p className="truncate text-[10px] text-faint">{item.source}</p>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function TextBlockView({ text }: { text: string }) {
  return (
    <div className="prose-muse text-[13.5px] leading-[1.7] text-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

export function ChatBlocks({ blocks, onPreview, onAddToCanvas, onGenerate }: Props) {
  return (
    <div className="space-y-3">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;

        switch (block.type) {
          case "text":
            return <TextBlockView key={key} text={block.text} />;
          case "tool":
            // 工具行由 RunProcess 统一渲染，这里不再平铺
            return null;
          case "image":
            return (
              <ImageCard
                key={key}
                block={block}
                onPreview={onPreview}
                onAddToCanvas={onAddToCanvas}
                onGenerate={onGenerate}
              />
            );
          case "video":
            return <VideoCard key={key} block={block} onGenerate={onGenerate} />;
          case "inspiration":
            return <InspirationCard key={key} block={block} onPreview={onPreview} />;
        }
      })}
    </div>
  );
}