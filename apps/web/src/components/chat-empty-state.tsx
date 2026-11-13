"use client";

import { ImagePlus, Plus } from "lucide-react";

type Props = {
  hasProject: boolean;
  disabled: boolean;
  onCreate: () => void;
  onUpload: () => void;
};

export function ChatEmptyState({ hasProject, disabled, onCreate, onUpload }: Props) {
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
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-8 text-center">
      <p className="text-[15px] font-medium tracking-tight">准备怎么开启你的创作？</p>
      <p className="mt-2 max-w-[260px] text-[12.5px] leading-[1.8] text-muted">
        上传一张本地参考图，或者直接在下方描述你想要的画面。
      </p>

      <button
        type="button"
        onClick={onUpload}
        disabled={disabled}
        className="mt-6 inline-flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-5 text-[13px] text-ink shadow-[0_8px_24px_-18px_rgba(24,24,27,0.35)] transition-colors hover:bg-canvas disabled:opacity-50"
      >
        <ImagePlus className="size-4 text-muted" strokeWidth={1.75} />
        上传本地参考
      </button>
    </div>
  );
}