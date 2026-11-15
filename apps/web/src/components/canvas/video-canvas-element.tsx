"use client";

import { Play } from "lucide-react";
import { useCallback, useRef, useState } from "react";

type Props = {
  src: string;
  width: number;
  height: number;
  durationSeconds?: number;
  title?: string;
};

/**
 * Excalidraw embeddable 里的内联视频：
 * 悬停自动播放（静音），移出暂停；点击切换。
 * 指针事件全部拦住，避免画布把播放误当成拖拽。
 */
export function VideoCanvasElement({
  src,
  width,
  height,
  durationSeconds,
  title,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    void video.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    );
  }, []);

  const pause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    setPlaying(false);
  }, []);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [pause, play, playing]);

  const stop = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation();
  }, []);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={title ? `播放视频：${title}` : "播放视频"}
      style={{ width, height }}
      className="group relative flex items-center justify-center overflow-hidden rounded-lg bg-black outline-none"
      onPointerDown={stop}
      onPointerUp={stop}
      onPointerMove={stop}
      onWheel={stop}
      onMouseEnter={play}
      onMouseLeave={pause}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        toggle();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          toggle();
        }
      }}
    >
      <video
        ref={videoRef}
        src={src}
        muted
        loop
        playsInline
        preload="metadata"
        className="h-full w-full object-contain"
      />

      {!playing && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20">
          <span className="grid size-11 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm">
            <Play className="size-5 translate-x-px" fill="currentColor" />
          </span>
        </div>
      )}

      {durationSeconds ? (
        <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[10px] text-white/90">
          {durationSeconds}s
        </span>
      ) : null}
    </div>
  );
}