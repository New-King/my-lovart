"use client";

import { Clapperboard, ImagePlus, LayoutGrid, Plus, Sparkles } from "lucide-react";

type Props = {
  hasProject: boolean;
  disabled: boolean;
  onCreate: () => void;
  onUpload: () => void;
  /** 点开场示例：把提示词填进输入框，让用户还能改 */
  onPickStarter: (text: string) => void;
};

const STARTERS = [
  {
    icon: LayoutGrid,
    title: "做一张海报",
    hint: "咖啡新品 · 秋季暖调 · 3:4",
    prompt: "我想做一张咖啡店秋季新品海报，暖色调",
  },
  {
    icon: Clapperboard,
    title: "做一条短片",
    hint: "产品宣传 · 16:9 横版",
    prompt: "我想做一条产品宣传短视频，16:9 横版",
  },
  {
    icon: Sparkles,
    title: "做一组封面",
    hint: "社交媒体 · 系列感",
    prompt: "我想做一组风格统一的社交媒体封面图",
  },
];

export function ChatEmptyState({
  hasProject,
  disabled,
  onCreate,
  onUpload,
  onPickStarter,
}: Props) {
  if (!hasProject) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 px-4 text-center">
        <div>
          <p className="text-[13.5px] font-medium tracking-tight">还没有项目</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
            新建一个项目，再描述你想做的画面。
          </p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
        >
          <Plus className="size-3.5" strokeWidth={2} />
          新建项目
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col justify-center px-1 py-8">
      <p className="text-[15px] font-medium tracking-tight">从一个想法开始</p>
      <p className="mt-1.5 text-[12px] leading-[1.8] text-muted">
        我会先确认比例、风格和用途，再开始生成。描述越具体，结果越接近你要的。
      </p>

      <div className="mt-5 space-y-1.5">
        {STARTERS.map((item) => (
          <button
            key={item.title}
            type="button"
            onClick={() => onPickStarter(item.prompt)}
            disabled={disabled}
            className="group flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent/30 hover:bg-accent-soft/40 disabled:opacity-50"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-canvas text-muted transition-colors group-hover:text-accent">
              <item.icon className="size-4" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-medium text-ink">{item.title}</span>
              <span className="mt-0.5 block truncate text-[10.5px] text-faint">{item.hint}</span>
            </span>
            <span className="text-[10px] text-faint transition-colors group-hover:text-accent">
              填入
            </span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onUpload}
        disabled={disabled}
        className="mt-3 inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-dashed border-line px-3 text-[12px] text-muted transition-colors hover:border-accent/40 hover:text-ink disabled:opacity-50"
      >
        <ImagePlus className="size-3.5" strokeWidth={1.75} />
        有参考图？上传一张再描述
      </button>

      <p className="mt-4 text-center text-[10.5px] leading-relaxed text-faint">
        也可以直接在下方说想法，缺信息时我会先问你一两个关键问题。
      </p>
    </div>
  );
}