"use client";

import dynamic from "next/dynamic";
import {
  AlertCircle,
  Check,
  Download,
  Loader2,
  Menu,
  MessageSquare,
  Share2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSceneVersion, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import {
  insertImageFileIntoCanvas,
  insertImageIntoCanvas,
  type CanvasImagePlacement,
} from "@/lib/canvas-image";
import {
  isChatImageDragEvent,
  parseChatImageDragData,
  type ChatImageDragPayload,
} from "@/lib/chat-canvas-drag";
import type { Project } from "@/lib/api";

const Excalidraw = dynamic(() => import("@excalidraw/excalidraw").then((m) => m.Excalidraw), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-[13px] text-faint">加载画布…</div>,
});

type Props = {
  project: Project | null;
  elements: unknown[];
  files: Record<string, unknown>;
  loaded: boolean;
  onSave: (elements: unknown[], files: Record<string, unknown>) => void;
  onOpenProjects: () => void;
  onShowChat: () => void;
};

type Toast = { kind: "success" | "error"; text: string };

function waitAtLeast(start: number, ms: number) {
  const remaining = ms - (Date.now() - start);
  return remaining > 0 ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
}

function hasFileDrag(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes("Files");
}

export function CanvasStage({
  project,
  elements,
  files,
  loaded,
  onSave,
  onOpenProjects,
  onShowChat,
}: Props) {
  const [status, setStatus] = useState<"saved" | "saving">("saved");
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragDepth = useRef(0);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const hydrated = useRef(false);
  const alive = useRef(true);
  const lastSaved = useRef("");

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const showToast = useCallback((kind: Toast["kind"], text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      if (!alive.current) return;
      apiRef.current = api;
      hydrated.current = false;
      lastSaved.current = "";

      if (elements.length === 0) {
        hydrated.current = true;
        return;
      }

      // Excalidraw 初始挂载时不一定能还原 files/elements，先压住自动保存，
      // 等 API 就绪后手动灌回服务端保存的场景。
      window.setTimeout(() => {
        if (apiRef.current !== api) return;

        const savedFiles = Object.values(files) as BinaryFileData[];
        if (savedFiles.length > 0) api.addFiles(savedFiles);

        api.updateScene({ elements: elements as never[] });
        api.scrollToContent(elements as never[], { fitToContent: true });
        hydrated.current = true;
      }, 100);
    },
    [elements, files],
  );

  const addChatImage = useCallback(
    async (payload: ChatImageDragPayload, point: CanvasImagePlacement | null) => {
      const api = apiRef.current;
      if (!api || !hydrated.current) {
        showToast("error", "画布还在加载，请稍后再试");
        return;
      }

      setBusy((count) => count + 1);
      const started = Date.now();
      try {
        await insertImageIntoCanvas(api, {
          url: payload.url,
          name: payload.title ?? "图片",
          mimeType: payload.mimeType,
          width: payload.width,
          height: payload.height,
          placement: point ?? undefined,
        });
        await waitAtLeast(started, 350);
        showToast("success", "图片已添加到画布");
      } catch (err) {
        console.error("[canvas] 聊天图片拖入失败", err);
        showToast("error", "图片添加失败，请重试");
      } finally {
        setBusy((count) => count - 1);
      }
    },
    [showToast],
  );

  const addFiles = useCallback(
    async (incoming: File[], point: CanvasImagePlacement | null) => {
      const api = apiRef.current;
      if (!api || !hydrated.current) {
        showToast("error", "画布还在加载，请稍后再试");
        return;
      }

      const images = incoming.filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) return;

      setBusy((count) => count + 1);
      const started = Date.now();
      let added = 0;

      for (const [index, file] of images.entries()) {
        const placement = point ? { x: point.x + index * 24, y: point.y + index * 24 } : undefined;
        try {
          await insertImageFileIntoCanvas(api, file, placement);
          added += 1;
        } catch (err) {
          console.error("[canvas] 文件添加失败", err);
        }
      }

      await waitAtLeast(started, 400);
      setBusy((count) => count - 1);

      if (added > 0) {
        showToast("success", added > 1 ? `已添加 ${added} 张图片` : "图片已添加到画布");
      } else {
        showToast("error", "图片添加失败，请重试");
      }
    },
    [showToast],
  );

  function handleDragEnter(event: React.DragEvent) {
    const dataTransfer = event.dataTransfer;
    if (!isChatImageDragEvent(dataTransfer) && !hasFileDrag(dataTransfer)) return;

    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: React.DragEvent) {
    const dataTransfer = event.dataTransfer;
    if (!isChatImageDragEvent(dataTransfer) && !hasFileDrag(dataTransfer)) return;

    event.preventDefault();
    event.stopPropagation();
    dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: React.DragEvent) {
    const dataTransfer = event.dataTransfer;
    if (!isChatImageDragEvent(dataTransfer) && !hasFileDrag(dataTransfer)) return;

    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }

  function handleDrop(event: React.DragEvent) {
    const dataTransfer = event.dataTransfer;
    const fromChat = isChatImageDragEvent(dataTransfer);
    const imageFiles = Array.from(dataTransfer.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!fromChat && imageFiles.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragActive(false);

    const api = apiRef.current;
    if (!api) {
      showToast("error", "画布还没准备好");
      return;
    }

    const appState = api.getAppState();
    const point = viewportCoordsToSceneCoords(
      { clientX: event.clientX, clientY: event.clientY },
      appState,
    );

    if (fromChat) {
      const payload = parseChatImageDragData(dataTransfer);
      if (payload) {
        void addChatImage(payload, point);
        return;
      }
    }

    if (imageFiles.length > 0) {
      void addFiles(imageFiles, point);
    }
  }

  function handlePaste(event: React.ClipboardEvent) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;

    const api = apiRef.current;
    if (!api) {
      showToast("error", "画布还没准备好");
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const appState = api.getAppState();
    const point = viewportCoordsToSceneCoords(
      {
        clientX: appState.offsetLeft + appState.width / 2,
        clientY: appState.offsetTop + appState.height / 2,
      },
      appState,
    );
    void addFiles(files, point);
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-canvas">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-2 lg:px-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenProjects}
            aria-label="打开项目"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink lg:hidden"
          >
            <Menu className="size-4" strokeWidth={1.75} />
          </button>
          <h1 className="min-w-0 truncate text-[13px] font-medium tracking-tight">
            {project?.name ?? "未选择项目"}
          </h1>
          <span className="hidden shrink-0 text-[11px] text-faint sm:inline">
            {status === "saving" ? "保存中…" : "已保存"}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onShowChat}
            aria-label="打开对话"
            className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink lg:hidden"
          >
            <MessageSquare className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="分享"
            className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <Share2 className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="导出"
            className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <Download className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <div
        className="relative flex-1 bg-surface"
        onDragEnterCapture={handleDragEnter}
        onDragOverCapture={handleDragOver}
        onDragLeaveCapture={handleDragLeave}
        onDropCapture={handleDrop}
        onPasteCapture={handlePaste}
      >
        {!project ? (
          <div className="grid h-full place-items-center px-6">
            <p className="text-[13px] text-faint">先新建一个项目。</p>
          </div>
        ) : !loaded ? (
          <div className="grid h-full place-items-center text-[13px] text-faint">加载画布…</div>
        ) : (
          <Excalidraw
            key={project.id}
            theme="light"
            langCode="zh-CN"
            initialData={{ elements: [] }}
            excalidrawAPI={handleApi}
            onChange={(next, _appState, nextFiles) => {
              if (!alive.current || !hydrated.current) return;

              const filesSignature = Object.values(nextFiles)
                .map((file) => `${file.id}:${file.dataURL.length}`)
                .sort()
                .join(",");
              const signature = `${getSceneVersion(next)}:${filesSignature}`;
              if (signature === lastSaved.current) return;
              lastSaved.current = signature;

              setStatus("saving");
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => {
                onSave(
                  next as unknown[],
                  nextFiles as unknown as Record<string, unknown>,
                );
                setStatus("saved");
              }, 600);
            }}
          />
        )}

        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-canvas/60">
            <div className="absolute inset-0 border-2 border-dashed border-accent/20" />
            <span className="relative rounded-full border border-line bg-surface px-3 py-1.5 text-[11px] text-muted shadow-[0_8px_30px_-12px_rgba(24,24,27,0.25)]">
              松开把图片放到画布
            </span>
          </div>
        )}

        {(busy > 0 || toast) && (
          <div
            className={`pointer-events-none absolute left-1/2 top-14 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface/95 px-3 py-1.5 text-[11px] shadow-[0_8px_30px_-12px_rgba(24,24,27,0.25)] ${
              toast?.kind === "error" && busy === 0 ? "text-danger" : "text-muted"
            }`}
          >
            {busy > 0 ? (
              <>
                <Loader2 className="size-3 animate-spin" strokeWidth={2} />
                正在上传图片…
              </>
            ) : toast ? (
              <>
                {toast.kind === "success" ? (
                  <Check className="size-3" strokeWidth={2} />
                ) : (
                  <AlertCircle className="size-3" strokeWidth={2} />
                )}
                {toast.text}
              </>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}