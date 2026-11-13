"use client";

import type {
  ChatBlock,
  ImageBlock,
  InspirationBlock,
  ToolBlock,
  VideoBlock,
} from "@my-lovart/shared";
import {
  AlertCircle,
  Check,
  Clapperboard,
  ImagePlus,
  Loader2,
  Search,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { guessMimeTypeFromUrl, setChatImageDragData } from "@/lib/chat-canvas-drag";

export type PreviewTarget = { src: string; name: string };

type Props = {
  blocks: ChatBlock[];
  onPreview: (target: PreviewTarget) => void;
};

const TOOL_ICONS = {
  generate_image: ImagePlus,
  generate_video: Clapperboard,
  search_inspiration: Search,
} as const;

function StatusMark({ status }: { status: ToolBlock["status"] }) {
  if (status === "running") return <Loader2 className="size-3 animate-spin text-faint" />;
  if (status === "failed") return <AlertCircle className="size-3 text-danger" />;
  return <Check className="size-3 text-faint" strokeWidth={2} />;
}

function ToolRow({ block }: { block: ToolBlock }) {
  const Icon = TOOL_ICONS[block.tool] ?? ImagePlus;

  return (
    <div className="flex items-center gap-2 text-[11.5px]">
      <Icon className="size-3.5 shrink-0 text-faint" strokeWidth={1.75} />
      <span className="font-medium text-muted">{block.title}</span>
      {block.detail && <span className="truncate text-faint">· {block.detail}</span>}
      <span className="ml-auto shrink-0">
        <StatusMark status={block.status} />
      </span>
    </div>
  );
}

function ImageCard({
  block,
  onPreview,
}: {
  block: ImageBlock;
  onPreview: Props["onPreview"];
}) {
  const label = block.prompt || "生成图像";

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

      <figcaption className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
        <span className="truncate text-[11.5px] text-muted">{label}</span>
        <span className="shrink-0 font-mono text-[9px] tracking-[0.12em] text-faint">
          {block.model} · {block.aspectRatio ?? `${block.width}×${block.height}`}
        </span>
      </figcaption>
    </figure>
  );
}

function VideoCard({ block }: { block: VideoBlock }) {
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
      <figcaption className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
        <span className="truncate text-[11.5px] text-muted">{block.prompt || "生成视频"}</span>
        <span className="shrink-0 font-mono text-[9px] tracking-[0.12em] text-faint">
          {block.model} · {block.durationSeconds ?? "?"}s · {block.width}×{block.height}
        </span>
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

export function ChatBlocks({ blocks, onPreview }: Props) {
  return (
    <div className="space-y-3">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;

        switch (block.type) {
          case "text":
            return <TextBlockView key={key} text={block.text} />;
          case "tool":
            return <ToolRow key={key} block={block} />;
          case "image":
            return <ImageCard key={key} block={block} onPreview={onPreview} />;
          case "video":
            return <VideoCard key={key} block={block} />;
          case "inspiration":
            return <InspirationCard key={key} block={block} onPreview={onPreview} />;
        }
      })}
    </div>
  );
}