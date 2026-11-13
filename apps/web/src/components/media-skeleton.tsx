"use client";

import type { AspectRatio } from "@my-lovart/shared";
import { Clapperboard, ImagePlus } from "lucide-react";

export function MediaSkeleton({
  kind,
  aspectRatio,
}: {
  kind: "image" | "video";
  aspectRatio?: AspectRatio;
}) {
  const ratio = aspectRatio
    ? aspectRatio.replace(":", " / ")
    : kind === "video"
      ? "16 / 9"
      : "3 / 4";
  const Icon = kind === "video" ? Clapperboard : ImagePlus;

  return (
    <div
      className="relative w-full max-w-[360px] overflow-hidden rounded-xl border border-line bg-canvas"
      style={{ aspectRatio: ratio, maxHeight: 360 }}
      aria-label={kind === "video" ? "视频生成中" : "图片生成中"}
      aria-busy="true"
    >
      <div className="absolute inset-0 grid place-items-center">
        <Icon className="size-6 text-faint/40" strokeWidth={1.5} />
      </div>
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="media-shimmer absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      </div>
    </div>
  );
}