"use client";

import {
  Clapperboard,
  Image as ImageIcon,
  LayoutTemplate,
  Megaphone,
  Palette,
  PenTool,
  Plus,
  type LucideIcon,
} from "lucide-react";

type Preset = {
  icon: LucideIcon;
  label: string;
  prompt: string;
};

const PRESETS: Preset[] = [
  {
    icon: Megaphone,
    label: "海报",
    prompt: "帮我设计一张秋季音乐节海报，画面简洁、有层次，适合竖版印刷。",
  },
  {
    icon: PenTool,
    label: "Logo",
    prompt: "为一个独立咖啡品牌设计 Logo，风格克制，给出图形思路和配色。",
  },
  {
    icon: ImageIcon,
    label: "社媒配图",
    prompt: "设计一组小红书封面，3 张，风格统一，标题醒目但不喧闹。",
  },
  {
    icon: LayoutTemplate,
    label: "版式",
    prompt: "把一段产品介绍排成一张 A4 版式，留白充足，层级清楚。",
  },
  {
    icon: Clapperboard,
    label: "分镜",
    prompt: "为一段 15 秒产品短片画 6 格分镜，说明每格的画面和镜头。",
  },
  {
    icon: Palette,
    label: "配色",
    prompt: "给我一套适合科技品牌的配色方案，附色值和搭配比例。",
  },
];

type Props = {
  hasProject: boolean;
  disabled: boolean;
  onCreate: () => void;
  onSend: (text: string) => void;
};

export function ChatEmptyState({ hasProject, disabled, onCreate, onSend }: Props) {
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
    <div className="flex min-h-full flex-col items-center justify-center px-3 py-8 text-center">
      <span className="font-mono text-[9px] tracking-[0.18em] text-faint">START WITH</span>
      <p className="mt-3 text-[13.5px] font-medium tracking-tight">从一个想法开始</p>
      <p className="mt-1.5 max-w-[260px] text-[12.5px] leading-[1.8] text-muted">
        描述画面、尺寸和风格，或者把参考图拖进输入框。
      </p>

      <div className="mt-6 flex max-w-[300px] flex-wrap justify-center gap-2">
        {PRESETS.map(({ icon: Icon, label, prompt }) => (
          <button
            key={label}
            type="button"
            disabled={disabled}
            onClick={() => onSend(prompt)}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12px] text-muted transition-colors hover:border-accent/20 hover:text-ink disabled:opacity-50"
          >
            <Icon className="size-3.5 text-faint" strokeWidth={1.75} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}