"use client";

import type {
  ChatBlock,
  ImageBlock,
  InspirationBlock,
  TextBlock,
  VideoBlock,
} from "@my-lovart/shared";
import {
  ArrowDownRight,
  Download,
  Frame,
  ImagePlus,
  Play,
} from "lucide-react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { guessMimeTypeFromUrl, setChatImageDragData } from "@/lib/chat-canvas-drag";
import { downloadAsset } from "@/lib/download";
import { useToast } from "./ui/toast";

export type PreviewTarget = { src: string; name: string };

type MediaBlock = ImageBlock | VideoBlock;

type Props = {
  blocks: ChatBlock[];
  onPreview: (target: PreviewTarget) => void;
  onAddToCanvas: (block: ImageBlock) => void;
  onAddReference: (item: { url: string; name: string; mimeType: string }) => void;
};

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
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      className="grid size-7 place-items-center rounded-md text-faint transition-colors hover:bg-canvas hover:text-ink"
    >
      {children}
    </button>
  );
}

function DownloadAction({ url, name }: { url: string; name: string }) {
  return (
    <ActionButton
      label="下载"
      onClick={() => {
        void downloadAsset(url, name);
      }}
    >
      <Download className="size-3.5" strokeWidth={1.75} />
    </ActionButton>
  );
}

function ImageCard({
  block,
  onPreview,
  onAddToCanvas,
}: {
  block: ImageBlock;
  onPreview: Props["onPreview"];
  onAddToCanvas: Props["onAddToCanvas"];
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

      <figcaption className="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] text-muted">{label}</p>
          <p className="truncate font-mono text-[9px] tracking-[0.08em] text-faint">
            {block.model} · {block.aspectRatio ?? `${block.width}×${block.height}`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <ActionButton label="放入画布" onClick={() => onAddToCanvas(block)}>
            <Frame className="size-3.5" strokeWidth={1.75} />
          </ActionButton>
          <DownloadAction url={block.url} name={label} />
        </div>
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
      <figcaption className="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] text-muted">{block.prompt || "生成视频"}</p>
          <p className="truncate font-mono text-[9px] tracking-[0.08em] text-faint">
            {block.model} · {block.durationSeconds ?? "?"}s · {block.width}×{block.height}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <DownloadAction url={block.url} name={block.prompt || "生成视频"} />
        </div>
      </figcaption>
    </figure>
  );
}

function CompactTile({
  block,
  onPreview,
  onAddToCanvas,
}: {
  block: MediaBlock;
  onPreview: Props["onPreview"];
  onAddToCanvas: Props["onAddToCanvas"];
}) {
  const label = block.prompt || (block.type === "video" ? "生成视频" : "生成图像");
  const preview = () =>
    onPreview({
      src: block.type === "video" ? (block.posterUrl ?? block.url) : block.url,
      name: label,
    });

  return (
    <div className="group relative w-[104px] shrink-0 overflow-hidden rounded-lg border border-line bg-canvas">
      {block.type === "image" ? (
        <button type="button" onClick={preview} className="block w-full">
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
            className="aspect-[3/4] w-full cursor-grab object-cover active:cursor-grabbing"
          />
        </button>
      ) : (
        <button type="button" onClick={preview} className="relative block w-full">
          <img
            src={block.posterUrl}
            alt={label}
            loading="lazy"
            className="aspect-[3/4] w-full object-cover"
          />
          <span className="absolute inset-0 grid place-items-center bg-ink/20">
            <span className="grid size-7 place-items-center rounded-full bg-ink/60 text-white">
              <Play className="size-3 fill-current" strokeWidth={0} />
            </span>
          </span>
        </button>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end gap-0.5 bg-gradient-to-t from-ink/45 to-transparent p-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100">
        {block.type === "image" && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onAddToCanvas(block);
            }}
            aria-label="放入画布"
            title="放入画布"
            className="grid size-6 place-items-center rounded-md bg-white/15 text-white backdrop-blur-sm transition-colors hover:bg-white/25"
          >
            <Frame className="size-3" strokeWidth={1.75} />
          </button>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void downloadAsset(block.url, label);
          }}
          aria-label="下载"
          title="下载"
          className="grid size-6 place-items-center rounded-md bg-white/15 text-white backdrop-blur-sm transition-colors hover:bg-white/25"
        >
          <Download className="size-3" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

function ArtifactRow({
  items,
  onPreview,
  onAddToCanvas,
}: {
  items: MediaBlock[];
  onPreview: Props["onPreview"];
  onAddToCanvas: Props["onAddToCanvas"];
}) {
  if (items.length === 1) {
    const block = items[0]!;
    return block.type === "image" ? (
      <ImageCard block={block} onPreview={onPreview} onAddToCanvas={onAddToCanvas} />
    ) : (
      <VideoCard block={block} />
    );
  }

  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((block) => (
        <CompactTile
          key={block.id}
          block={block}
          onPreview={onPreview}
          onAddToCanvas={onAddToCanvas}
        />
      ))}
    </div>
  );
}

function InspirationCard({
  block,
  groupIndex,
  onPreview,
  onAddReference,
}: {
  block: InspirationBlock;
  groupIndex: number;
  onPreview: Props["onPreview"];
  onAddReference: Props["onAddReference"];
}) {
  const toast = useToast();
  const [label, query] = block.query.split("｜");

  return (
    <section className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <ImagePlus className="size-3.5 text-faint" strokeWidth={1.75} />
        <span className="font-mono text-[9px] tracking-[0.16em] text-faint">
          灵感参考 · 第 {groupIndex} 组
        </span>
        <span className="ml-auto text-[10px] text-faint">{block.items.length} 条</span>
      </div>
      <p className="mt-1.5 text-[12px] text-muted">{label}</p>
      {query ? <p className="mt-0.5 text-[10px] text-faint">{query}</p> : null}
      <p className="mt-1 text-[10.5px] text-faint">
        点缩略图右上角箭头加入对话；也可以回复“第 {groupIndex} 组第 1 张”。
      </p>

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        {block.items.map((item, index) => {
          const mimeType = guessMimeTypeFromUrl(item.imageUrl);
          return (
            <div
              key={item.id}
              className="group relative overflow-hidden rounded-lg border border-line bg-canvas"
            >
              <button
                type="button"
                onClick={() => onPreview({ src: item.imageUrl, name: item.title })}
                aria-label={`查看 ${item.title}`}
                className="block w-full text-left"
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
                      mimeType,
                      width: item.width,
                      height: item.height,
                    })
                  }
                  className="aspect-[4/3] w-full cursor-grab object-cover transition-opacity group-hover:opacity-90 active:cursor-grabbing"
                />
                <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-ink/70 px-1.5 py-0.5 font-mono text-[9px] text-white">
                  {groupIndex}.{index + 1}
                </span>
                <div className="px-2 py-1.5">
                  <p className="truncate text-[11.5px] text-ink">{item.title}</p>
                  <p className="truncate text-[10px] text-faint">{item.source}</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  onAddReference({ url: item.imageUrl, name: item.title, mimeType });
                  toast("success", "已加入对话框");
                }}
                aria-label={`把 ${item.title} 加入对话`}
                title="加入对话"
                className="absolute left-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-ink/70 text-white opacity-0 transition-all hover:bg-ink group-hover:opacity-100 max-sm:opacity-100"
              >
                <ArrowDownRight className="size-3.5" strokeWidth={2} />
              </button>
            </div>
          );
        })}
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

export function ChatBlocks({ blocks, onPreview, onAddToCanvas, onAddReference }: Props) {
  type Unit =
    | { key: string; kind: "text"; block: TextBlock }
    | { key: string; kind: "inspiration"; block: InspirationBlock; groupIndex: number }
    | { key: string; kind: "media"; items: MediaBlock[] };

  const units: Unit[] = [];
  const mediaByBatch = new Map<string, number>();
  let inspirationGroups = 0;

  for (const block of blocks) {
    if (block.type === "tool") continue;

    if (block.type === "text") {
      units.push({ key: `text-${block.text.slice(0, 12)}`, kind: "text", block });
      continue;
    }

    if (block.type === "inspiration") {
      inspirationGroups += 1;
      units.push({
        key: `insp-${block.id}`,
        kind: "inspiration",
        block,
        groupIndex: inspirationGroups,
      });
      continue;
    }

    const batch = block.batchId ?? block.id;
    const existing = mediaByBatch.get(batch);
    if (existing !== undefined) {
      const unit = units[existing];
      if (unit?.kind === "media") unit.items.push(block);
      continue;
    }

    mediaByBatch.set(batch, units.length);
    units.push({ key: `media-${batch}`, kind: "media", items: [block] });
  }

  return (
    <div className="space-y-3">
      {units.map((unit) => {
        if (unit.kind === "text") {
          return <TextBlockView key={unit.key} text={unit.block.text} />;
        }
        if (unit.kind === "inspiration") {
          return (
            <InspirationCard
              key={unit.key}
              block={unit.block}
              groupIndex={unit.groupIndex}
              onPreview={onPreview}
              onAddReference={onAddReference}
            />
          );
        }
        return (
          <ArtifactRow
            key={unit.key}
            items={unit.items}
            onPreview={onPreview}
            onAddToCanvas={onAddToCanvas}
          />
        );
      })}
    </div>
  );
}