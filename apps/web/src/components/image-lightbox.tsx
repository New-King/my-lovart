"use client";

import { Download, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { downloadAsset } from "@/lib/download";

export function ImageLightbox({
  src,
  name,
  onClose,
}: {
  src: string;
  name: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center bg-ink/70 p-6 backdrop-blur-sm"
    >
      <div className="absolute right-5 top-5 flex items-center gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void downloadAsset(src, name);
          }}
          aria-label="下载图片"
          title="下载"
          className="grid size-9 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <Download className="size-4" strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭预览"
          className="grid size-9 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <X className="size-4" strokeWidth={2} />
        </button>
      </div>

      <img
        src={src}
        alt={name}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain shadow-[0_24px_80px_-20px_rgba(0,0,0,0.5)]"
      />

      <p className="absolute bottom-5 max-w-[80vw] truncate text-[11px] text-white/60">
        {name}
      </p>
    </div>,
    document.body,
  );
}