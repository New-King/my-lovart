"use client";

import dynamic from "next/dynamic";
import {
  BookOpen,
  Download,
  ImagePlus,
  LocateFixed,
  Loader2,
  Menu,
  MessageSquare,
  PanelLeftOpen,
  Rows3,
  Share2,
} from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { getSceneVersion, viewportCoordsToSceneCoords, getCommonBounds, sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { CanvasCommand } from "@my-lovart/shared";
import { applyCanvasCommands } from "@/lib/canvas-command-runner";
import type { CanvasCommandResult } from "@/lib/canvas-commands";
import {
  arrangeCanvasImages,
  insertImageFileIntoCanvas,
  insertImageIntoCanvas,
  loadImageDataUrlSize,
  type CanvasImagePlacement,
} from "@/lib/canvas-image";
import {
  isChatImageDragEvent,
  parseChatImageDragData,
  type ChatImageDragPayload,
} from "@/lib/chat-canvas-drag";
import type { Project } from "@/lib/api";
import { getWorkspace } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useToast } from "./ui/toast";

const Excalidraw = dynamic(() => import("@excalidraw/excalidraw").then((m) => m.Excalidraw), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-[13px] text-faint">加载画布…</div>,
});

type Props = {
  project: Project | null;
  elements: unknown[];
  files: Record<string, unknown>;
  loaded: boolean;
  railCollapsed: boolean;
  onSave: (elements: unknown[], files: Record<string, unknown>) => Promise<void>;
  onOpenProjects: () => void;
  onShowChat: () => void;
  onOpenMaterials: () => void;
};

export type CanvasStageHandle = {
  /** 生成结果落到画布；内部会把远端图片转成 data URL 再插入 */
  insertImage: (input: {
    url: string;
    name: string;
    mimeType?: string;
    width?: number;
    height?: number;
    batchId?: string;
    assetId?: string;
    title?: string;
    prompt?: string;
    /** 生成链路自动入画布时不弹 toast */
    silent?: boolean;
  }) => Promise<void>;
  /** 服务端作业/其他客户端改了画布后，重新拉取并应用 */
  syncFromServer: () => Promise<void>;
  /** 执行 Agent 下发的画布动作（移动 / 对齐 / 删除…） */
  applyCommands: (commands: CanvasCommand[]) => CanvasCommandResult;
};

function waitAtLeast(start: number, ms: number) {
  const remaining = ms - (Date.now() - start);
  return remaining > 0 ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
}

function hasFileDrag(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes("Files");
}

export const CanvasStage = forwardRef<CanvasStageHandle, Props>(function CanvasStage(
  {
    project,
    elements,
    files,
    loaded,
    railCollapsed,
    onSave,
    onOpenProjects,
    onShowChat,
    onOpenMaterials,
  },
  ref,
) {
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(0);
  const [showReturn, setShowReturn] = useState(false);
  const showToast = useToast();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const hydrated = useRef(false);
  const alive = useRef(true);
  const lastSaved = useRef("");
  /** 框选矩形（场景坐标），pointerup 后用来做「相交即选中」 */
  const selectionBox = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const preSelection = useRef<Record<string, true>>({});
  /** 原生图片工具选完文件后，等文件可用就自动落位；避免半成品被自动保存 */
  const pendingImageJob = useRef<string | null>(null);

  const installSelectionGuards = useCallback((api: ExcalidrawImperativeAPI) => {
    api.onPointerDown((tool) => {
      if (tool.type === "selection") {
        preSelection.current = { ...api.getAppState().selectedElementIds };
      }
    });

    api.onPointerUp((tool, _state, event) => {
      if (tool.type !== "selection") return;
      const box = selectionBox.current;
      selectionBox.current = null;
      if (!box) return;

      // 等 Excalidraw 自己先完成「完全包裹」的选中，再补上相交的元素
      window.setTimeout(() => {
        if (!alive.current || apiRef.current !== api) return;
        const base = (event as PointerEvent).shiftKey ? preSelection.current : {};
        const selected: Record<string, true> = { ...base };
        for (const element of api.getSceneElements()) {
          if (element.isDeleted) continue;
          if (
            element.x < box.x + box.width &&
            element.x + element.width > box.x &&
            element.y < box.y + box.height &&
            element.y + element.height > box.y
          ) {
            selected[element.id] = true;
          }
        }
        api.updateScene({ appState: { selectedElementIds: selected } });
      }, 0);
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Excalidraw 自带的图片工具在鼠标操作下会进入「点一下画布再落位」状态，
  // 且元素初始宽高是 0，直接按宽高插会变成 1×1。这里等文件真正可读后，
  // 用图片原始尺寸等比缩到 400×500 以内，直接放到视口中心。
  useEffect(() => {
    let cancelled = false;

    async function placePending(api: ExcalidrawImperativeAPI, id: string, dataURL: string) {
      try {
        const size = await loadImageDataUrlSize(dataURL);
        if (cancelled || apiRef.current !== api) return;

        const appState = api.getAppState();
        if (appState.pendingImageElementId !== id) return;

        const scene = api.getSceneElements();
        const pending = scene.find((element) => element.id === id);
        if (!pending) return;

        const scale = Math.min(1, 400 / size.width, 500 / size.height);
        const width = Math.max(1, Math.round(size.width * scale));
        const height = Math.max(1, Math.round(size.height * scale));
        const center = viewportCoordsToSceneCoords(
          {
            clientX: appState.offsetLeft + appState.width / 2,
            clientY: appState.offsetTop + appState.height / 2,
          },
          appState,
        );

        api.updateScene({
          elements: scene.map((element) =>
            element.id === id
              ? {
                  ...element,
                  x: center.x - width / 2,
                  y: center.y - height / 2,
                  width,
                  height,
                  status: "saved" as const,
                  version: element.version + 1,
                  versionNonce: Math.floor(Math.random() * 2_000_000_000),
                  updated: Date.now(),
                }
              : element,
          ),
          appState: { pendingImageElementId: null },
          captureUpdate: "IMMEDIATELY",
        });
        api.setActiveTool({ type: "selection" });
      } catch (err) {
        console.error("[canvas] 原生图片落位失败", err);
        pendingImageJob.current = null;
      }
    }

    const interval = window.setInterval(() => {
      const api = apiRef.current;
      if (!api || !hydrated.current) return;

      const id = api.getAppState().pendingImageElementId;
      if (!id) {
        pendingImageJob.current = null;
        return;
      }
      if (pendingImageJob.current === id) return;

      const pending = api.getSceneElements().find((element) => element.id === id);
      const fileId = (pending as { fileId?: unknown } | undefined)?.fileId;
      if (typeof fileId !== "string") return;

      const file = api.getFiles()[fileId];
      if (!file?.dataURL) return;

      pendingImageJob.current = id;
      void placePending(api, id, file.dataURL);
    }, 120);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const updateVisibility = useCallback((api: ExcalidrawImperativeAPI) => {
    const scene = api.getSceneElements();
    if (scene.length === 0) {
      setShowReturn(false);
      return;
    }

    const appState = api.getAppState();
    const [x1, y1, x2, y2] = getCommonBounds(scene);
    const topLeft = sceneCoordsToViewportCoords({ sceneX: x1, sceneY: y1 }, appState);
    const bottomRight = sceneCoordsToViewportCoords({ sceneX: x2, sceneY: y2 }, appState);
    const visible =
      bottomRight.x > 0 &&
      topLeft.x < appState.width &&
      bottomRight.y > 0 &&
      topLeft.y < appState.height;
    setShowReturn(!visible);
  }, []);

  const fitContent = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    api.scrollToContent(api.getSceneElements(), { fitToContent: true });
    setShowReturn(false);
  }, []);

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      if (!alive.current) return;
      apiRef.current = api;
      hydrated.current = false;
      lastSaved.current = "";
      installSelectionGuards(api);

      if (elements.length === 0) {
        hydrated.current = true;
        setShowReturn(false);
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
        updateVisibility(api);
      }, 100);
    },
    [elements, files, updateVisibility, installSelectionGuards],
  );

  const addChatImage = useCallback(
    async (
      payload: ChatImageDragPayload,
      point: CanvasImagePlacement | null,
      silent = false,
    ) => {
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
          ...(payload.batchId ? { batchId: payload.batchId } : {}),
          ...(payload.assetId ? { assetId: payload.assetId } : {}),
          ...(payload.title ? { title: payload.title } : {}),
          ...(payload.prompt ? { prompt: payload.prompt } : {}),
        });
        await waitAtLeast(started, silent ? 0 : 350);
        if (!silent) showToast("success", "图片已添加到画布");
      } catch (err) {
        console.error("[canvas] 聊天图片拖入失败", err);
        if (!silent) showToast("error", "图片添加失败，请重试");
      } finally {
        setBusy((count) => count - 1);
      }
    },
    [showToast],
  );

  useImperativeHandle(
    ref,
    () => ({
      insertImage: (input) =>
        addChatImage(
          {
            url: input.url,
            title: input.name,
            mimeType: input.mimeType,
            width: input.width,
            height: input.height,
            ...(input.batchId ? { batchId: input.batchId } : {}),
            ...(input.assetId ? { assetId: input.assetId } : {}),
            ...(input.prompt ? { prompt: input.prompt } : {}),
          },
          null,
          input.silent ?? false,
        ),
      applyCommands(commands) {
        const api = apiRef.current;
        if (!api || !hydrated.current) {
          return { applied: 0, errors: ["画布还没准备好，操作没有执行"] };
        }
        try {
          return applyCanvasCommands(api, commands);
        } catch (err) {
          console.error("[canvas] 执行 Agent 画布操作失败", err);
          return {
            applied: 0,
            errors: [err instanceof Error ? err.message : "画布操作失败"],
          };
        }
      },
      async syncFromServer() {
        if (!project) return;
        const api = apiRef.current;
        if (!api) return;
        const workspace = await getWorkspace(project.id);
        const files = Object.values(workspace.files ?? {}) as BinaryFileData[];
        if (files.length > 0) api.addFiles(files);
        api.updateScene({
          elements: workspace.elements as never[],
          captureUpdate: "IMMEDIATELY",
        });
      },
    }),
    [addChatImage, project],
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

  function handleFilePick(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    const api = apiRef.current;
    if (!api || !hydrated.current) {
      showToast("error", "画布还在加载，请稍后再试");
      return;
    }

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
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink",
              !railCollapsed && "lg:hidden",
            )}
          >
            {railCollapsed ? (
              <PanelLeftOpen className="size-4" strokeWidth={1.75} />
            ) : (
              <Menu className="size-4" strokeWidth={1.75} />
            )}
          </button>
          <h1 className="min-w-0 truncate text-[13px] font-medium tracking-tight">
            {project?.name ?? "未选择项目"}
          </h1>
          <span className="hidden shrink-0 text-[11px] text-faint sm:inline">
            {status === "saving" ? "保存中…" : status === "error" ? "保存失败" : "已保存"}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={handleFilePick}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="插入图片"
            aria-label="插入图片"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <ImagePlus className="size-4" strokeWidth={1.75} />
            <span className="hidden sm:inline">图片</span>
          </button>
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
            onClick={() => {
              const api = apiRef.current;
              if (!api || !hydrated.current) {
                showToast("error", "画布还在加载，请稍后再试");
                return;
              }
              const count = arrangeCanvasImages(api);
              setShowReturn(false);
              showToast(
                count > 0 ? "success" : "info",
                count > 0 ? `已重排 ${count} 张图片` : "画布上还没有图片",
              );
            }}
            title="整理画布：按任务批次把图片排成一行行"
            aria-label="整理画布"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <Rows3 className="size-4" strokeWidth={1.75} />
            <span className="hidden sm:inline">整理</span>
          </button>
          <button
            type="button"
            onClick={onOpenMaterials}
            title="素材库"
            aria-label="素材库"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <BookOpen className="size-4" strokeWidth={1.75} />
            <span className="hidden sm:inline">素材库</span>
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
            onChange={(next, appState, nextFiles) => {
              if (!alive.current || !hydrated.current) return;
              const api = apiRef.current;
              if (!api) return;

              // 记录框选矩形，pointerup 时用来做相交选中
              const selection = appState.selectionElement;
              if (selection && (selection.width > 2 || selection.height > 2)) {
                selectionBox.current = {
                  x: selection.x,
                  y: selection.y,
                  width: selection.width,
                  height: selection.height,
                };
              }

              // 原生图片工具选完文件后会在 pending 状态等落位；此时元素宽高还是 0，
// 先不要保存半成品，交给上面的自动落位流程处理。
              if (appState.pendingImageElementId) return;

              updateVisibility(api);

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
                void onSave(
                  next as unknown[],
                  nextFiles as unknown as Record<string, unknown>,
                )
                  .then(() => {
                    if (alive.current) setStatus("saved");
                  })
                  .catch(() => {
                    if (alive.current) setStatus("error");
                  });
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

        {showReturn && (
          <button
            type="button"
            onClick={fitContent}
            className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[11px] text-ink shadow-[0_10px_30px_-14px_rgba(24,24,27,0.4)] transition-colors hover:bg-canvas"
          >
            <LocateFixed className="size-3.5 text-muted" strokeWidth={1.75} />
            回到内容
          </button>
        )}

        {(busy > 0) && (
          <div className="pointer-events-none absolute left-1/2 top-14 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface/95 px-3 py-1.5 text-[11px] text-muted shadow-[0_8px_30px_-12px_rgba(24,24,27,0.25)]">
            <Loader2 className="size-3 animate-spin" strokeWidth={2} />
            正在处理图片…
          </div>
        )}
      </div>
    </main>
  );
});