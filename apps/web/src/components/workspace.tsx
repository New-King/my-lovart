"use client";

import type {
  AspectRatio,
  ChatAttachment,
  ChatMessage,
  GenerateRequest,
  ImageBlock,
  RunEvent,
} from "@my-lovart/shared";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/auth";
import {
  createProject,
  generateStream,
  getWorkspace,
  listProjects,
  saveCanvas,
  sendMessageStream,
  type Project,
  type WorkspaceData,
} from "@/lib/api";
import { CanvasStage, type CanvasStageHandle } from "./canvas-stage";
import { ChatPanel } from "./chat-panel";
import type { ChatComposerHandle } from "./chat-composer";
import { MaterialLibraryPanel } from "./material-library-panel";
import { ProjectRail } from "./project-rail";
import { useToast } from "./ui/toast";

const DRAFT_PREFIX = "draft-";
const IMAGE_ONLY_PROMPT = "看看这些参考图，给我一些具体的建议。";

function cancelLocal(message: ChatMessage): ChatMessage {
  return {
    ...message,
    status: "canceled",
    updatedAt: new Date().toISOString(),
    steps: (message.steps ?? []).map((step) =>
      step.status === "running" || step.status === "pending"
        ? { ...step, status: "failed" as const, finishedAt: new Date().toISOString() }
        : step,
    ),
    blocks: (message.blocks ?? []).map((block) =>
      block.type === "tool" &&
      (block.status === "running" || block.status === "queued")
        ? { ...block, status: "failed" as const }
        : block,
    ),
    thoughts: (message.thoughts ?? []).map((thought) =>
      thought.finishedAt ? thought : { ...thought, finishedAt: new Date().toISOString() },
    ),
  };
}

function applyRunEvent(prev: WorkspaceData | null, event: RunEvent): WorkspaceData | null {
  if (!prev) return prev;
  const at = event.at;
  const current = prev;

  const patch = (fn: (message: ChatMessage) => ChatMessage): WorkspaceData => {
    if (!current.messages.some((message) => message.id === event.messageId)) return current;
    return {
      ...current,
      messages: current.messages.map((message) =>
        message.id === event.messageId ? fn(message) : message,
      ),
    };
  };

  switch (event.type) {
    case "run.accepted": {
      if (prev.messages.some((message) => message.id === event.messageId)) return prev;
      const message: ChatMessage = {
        id: event.messageId,
        role: "assistant",
        content: "",
        createdAt: at,
        updatedAt: at,
        status: "queued",
        steps: [],
        blocks: [],
        ...(event.queuePosition !== undefined
          ? { queuePosition: event.queuePosition }
          : {}),
      };
      return { ...prev, messages: [...prev.messages, message] };
    }
    case "run.started":
      return patch((message) => ({ ...message, status: "streaming", updatedAt: at }));
    case "step.started":
      return patch((message) => ({
        ...message,
        updatedAt: at,
        steps: [...(message.steps ?? []), event.step],
      }));
    case "step.updated":
      return patch((message) => ({
        ...message,
        updatedAt: at,
        steps: (message.steps ?? []).map((step) =>
          step.id === event.stepId
            ? {
                ...step,
                ...(event.status ? { status: event.status } : {}),
                ...(event.detail !== undefined ? { detail: event.detail } : {}),
                ...(event.status === "done" || event.status === "failed"
                  ? { finishedAt: at }
                  : {}),
              }
            : step,
        ),
      }));
    case "thinking.started":
      return patch((message) => ({
        ...message,
        updatedAt: at,
        thoughts: [
          ...(message.thoughts ?? []),
          { id: event.thoughtId, text: "", startedAt: event.startedAt },
        ],
      }));
    case "thinking.delta":
      return patch((message) => ({
        ...message,
        updatedAt: at,
        thoughts: (message.thoughts ?? []).map((thought) =>
          thought.id === event.thoughtId
            ? { ...thought, text: thought.text + event.delta }
            : thought,
        ),
      }));
    case "thinking.completed":
      return patch((message) => ({
        ...message,
        updatedAt: at,
        thoughts: (message.thoughts ?? []).map((thought) =>
          thought.id === event.thoughtId ? { ...thought, finishedAt: at } : thought,
        ),
      }));
    case "message.delta":
      return patch((message) => ({
        ...message,
        updatedAt: at,
        content: message.content + event.delta,
      }));
    case "tool.started":
      return patch((message) => ({
        ...message,
        updatedAt: at,
        blocks: [...(message.blocks ?? []), event.tool],
      }));
    case "tool.progress":
      return patch((message) => ({
        ...message,
        updatedAt: at,
        blocks: (message.blocks ?? []).map((block) =>
          block.type === "tool" && block.id === event.toolCallId
            ? {
                ...block,
                status: block.status === "queued" ? ("running" as const) : block.status,
                ...(event.progress !== undefined ? { progress: event.progress } : {}),
                ...(event.stage !== undefined ? { stage: event.stage } : {}),
              }
            : block,
        ),
      }));
    case "tool.completed":
      return patch((message) => ({
        ...message,
        updatedAt: at,
        blocks: (message.blocks ?? []).map((block) =>
          block.type === "tool" && block.id === event.toolCallId
            ? {
                ...block,
                status: "done" as const,
                progress: 100,
                finishedAt: at,
                ...(event.outputSummary !== undefined
                  ? { detail: event.outputSummary }
                  : {}),
              }
            : block,
        ),
      }));
    case "tool.failed":
      return patch((message) => ({
        ...message,
        updatedAt: at,
        blocks: (message.blocks ?? []).map((block) =>
          block.type === "tool" && block.id === event.toolCallId
            ? { ...block, status: "failed" as const, detail: event.error.message, finishedAt: at }
            : block,
        ),
      }));
    case "artifact.ready":
      return patch((message) => ({
        ...message,
        updatedAt: at,
        blocks: [...(message.blocks ?? []), event.artifact],
      }));
    case "canvas.sync":
      return prev;
    case "run.completed":
      return patch((message) => ({ ...message, status: "completed", updatedAt: at }));
    case "run.canceled":
      return patch((message) => ({ ...message, status: "canceled", updatedAt: at }));
    case "run.failed":
      return patch((message) => ({
        ...message,
        status: "failed",
        updatedAt: at,
        error: event.error.message,
        failure: event.error,
      }));
    default:
      return prev;
  }
}

type LastRun = {
  projectId: string;
  kind: "auto" | "image" | "video";
  prompt: string;
  aspectRatio?: AspectRatio;
  attachments: ChatAttachment[];
};

export function Workspace() {
  const router = useRouter();
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [running, setRunning] = useState(false);
  const [mobileView, setMobileView] = useState<"chat" | "canvas">("chat");
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [materialPanel, setMaterialPanel] = useState<"manage" | "select" | null>(null);
  const [loadingProject, setLoadingProject] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const skipLoadFor = useRef<string | null>(null);
  const chatComposerRef = useRef<ChatComposerHandle>(null);
  const canvasRef = useRef<CanvasStageHandle>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastRunRef = useRef<LastRun | null>(null);

  const refreshProjects = useCallback(async () => {
    const list = await listProjects().catch(() => null);
    if (list) setProjects(list);
    else toast("error", "项目列表加载失败，请刷新重试");
    return list ?? [];
  }, [toast]);

  useEffect(() => {
    refreshProjects().then((list) => {
      setActiveId((prev) => prev ?? list[0]?.id ?? null);
    });
  }, [refreshProjects]);

  // 草稿只在本地存在，切走就丢弃；已保存的项目才去拉数据
  useEffect(() => {
    if (!activeId || activeId.startsWith(DRAFT_PREFIX)) return;
    if (skipLoadFor.current === activeId) {
      skipLoadFor.current = null;
      return;
    }
    let cancelled = false;
    setData(null);
    setLoadingProject(true);
    setLoadingError(null);
    getWorkspace(activeId)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setLoadingProject(false);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "加载失败";
        setLoadingError(message);
        setLoadingProject(false);
        toast("error", "对话加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, reloadToken, toast]);

  /** 草稿在第一次真正产生内容时才落库，避免点一下「新建」就多一个空项目 */
  const ensureProject = useCallback(
    async (name?: string): Promise<string> => {
      if (!activeId) throw new Error("没有选中的项目");
      if (!activeId.startsWith(DRAFT_PREFIX)) return activeId;

      const created = await createProject(name ?? "未命名项目");
      setProjects((prev) => [created, ...prev]);
      setDraftId(null);
      setLoadingError(null);
      skipLoadFor.current = created.id;
      setActiveId(created.id);
      setData((prev) => ({
        projectId: created.id,
        elements: prev?.elements ?? [],
        files: prev?.files ?? {},
        messages: prev?.messages ?? [],
      }));
      return created.id;
    },
    [activeId],
  );

  const handleEvent = useCallback((event: RunEvent) => {
    setData((prev) => applyRunEvent(prev, event));
    if (event.type === "artifact.ready" && event.artifact.type === "image") {
      const block: ImageBlock = event.artifact;
      void canvasRef.current?.insertImage({
        url: block.url,
        name: block.prompt || "生成图像",
        mimeType: block.mimeType,
        width: block.width,
        height: block.height,
      });
    }
  }, []);

  const runStream = useCallback(
    async (
      invoke: (onEvent: (event: RunEvent) => void, signal: AbortSignal) => Promise<void>,
    ): Promise<{ ok: boolean }> => {
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      let sawAccepted = false;
      try {
        await invoke((event) => {
          if (event.type === "run.accepted") sawAccepted = true;
          handleEvent(event);
        }, controller.signal);
        return { ok: true };
      } catch (err) {
        if (controller.signal.aborted) return { ok: true };
        const message = err instanceof Error ? err.message : "生成失败";
        // 已经进入运行的消息用消息内的失败卡片提示，避免和 toast 重复
        if (!sawAccepted) toast("error", message);
        return { ok: false };
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setRunning(false);
        // 流意外中断时不要把消息永远挂在「生成中」
        setData((prev) =>
          prev
            ? {
                ...prev,
                messages: prev.messages.map((message) =>
                  message.status === "streaming" || message.status === "queued"
                    ? cancelLocal(message)
                    : message,
                ),
              }
            : prev,
        );
      }
    },
    [handleEvent, toast],
  );

  const handleLogout = async () => {
    setProjectsOpen(false);
    abortRef.current?.abort();
    await signOut();
    router.push("/");
  };

  const handleCreate = () => {
    setProjectsOpen(false);
    abortRef.current?.abort();
    if (draftId) {
      setActiveId(draftId);
      return;
    }
    const id = `${DRAFT_PREFIX}${crypto.randomUUID()}`;
    setDraftId(id);
    setActiveId(id);
    setData({ projectId: id, elements: [], files: {}, messages: [] });
    setLoadingProject(false);
    setLoadingError(null);
  };

  const handleSelect = (id: string) => {
    setProjectsOpen(false);
    if (id === activeId) return;
    abortRef.current?.abort();
    if (draftId && id !== draftId) setDraftId(null);
    setActiveId(id);
  };

  const draft: Project | null = draftId
    ? {
        id: draftId,
        name: "未命名项目",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isDraft: true,
      }
    : null;

  const allProjects = draft ? [draft, ...projects] : projects;
  const activeProject = allProjects.find((project) => project.id === activeId) ?? null;

  const handleSaveCanvas = useCallback(
    async (elements: unknown[], files: Record<string, unknown>) => {
      if (!activeId) return;
      // 草稿上什么都没画，就不必为一个空画布建项目
      if (activeId.startsWith(DRAFT_PREFIX) && elements.length === 0) return;
      try {
        const projectId = await ensureProject();
        await saveCanvas(projectId, elements, files);
      } catch (err) {
        console.error("[workspace] save failed", err);
        toast("error", "画布保存失败");
        throw err;
      }
    },
    [activeId, ensureProject, toast],
  );

  const handleSend = async (
    text: string,
    attachments: ChatAttachment[] = [],
    aspectRatio: AspectRatio = "3:4",
  ): Promise<boolean> => {
    if (!activeId) return false;
    if (running) {
      toast("info", "正在生成，先停止或等它结束");
      return false;
    }

    const trimmed = text.trim();
    const prompt = trimmed || (attachments.length > 0 ? IMAGE_ONLY_PROMPT : "");
    if (!prompt) return false;

    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: trimmed || prompt,
      createdAt: new Date().toISOString(),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    setData((prev) => (prev ? { ...prev, messages: [...prev.messages, optimistic] } : prev));

    try {
      // 第一句话就是项目名，避免左栏堆一排「未命名项目」
      const projectId = await ensureProject(prompt.slice(0, 18));
      lastRunRef.current = {
        projectId,
        kind: "auto",
        prompt,
        aspectRatio,
        attachments,
      };
      const result = await runStream((onEvent, signal) =>
        sendMessageStream(
          projectId,
          { text: prompt, attachments, aspectRatio },
          onEvent,
          signal,
        ),
      );
      if (!result.ok) {
        setData((prev) =>
          prev
            ? {
                ...prev,
                messages: prev.messages.filter((message) => message.id !== optimistic.id),
              }
            : prev,
        );
      }
      return result.ok;
    } catch (err) {
      setData((prev) =>
        prev
          ? {
              ...prev,
              messages: prev.messages.filter((message) => message.id !== optimistic.id),
            }
          : prev,
      );
      const message = err instanceof Error ? err.message : "发送失败";
      toast("error", message);
      return false;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setData((prev) =>
      prev
        ? {
            ...prev,
            messages: prev.messages.map((message) =>
              message.status === "streaming" || message.status === "queued"
                ? cancelLocal(message)
                : message,
            ),
          }
        : prev,
    );
    toast("info", "已停止生成");
  };

  const handleGenerate = async (input: GenerateRequest) => {
    if (!activeId) return;
    if (running) {
      toast("info", "正在生成，先停止或等它结束");
      return;
    }
    try {
      const projectId = await ensureProject(input.prompt.slice(0, 18) || "未命名项目");
      lastRunRef.current = {
        projectId,
        kind: input.kind,
        prompt: input.prompt,
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        attachments: input.attachments ?? [],
      };
      await runStream((onEvent, signal) =>
        generateStream(projectId, input, onEvent, signal),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "生成失败";
      toast("error", message);
    }
  };

  const handleRetry = () => {
    const last =
      lastRunRef.current && lastRunRef.current.projectId === activeId
        ? lastRunRef.current
        : null;
    const fallbackPrompt =
      [...(data?.messages ?? [])].reverse().find((message) => message.role === "user")
        ?.content ?? "";
    const prompt = last?.prompt ?? fallbackPrompt;
    if (!prompt) {
      toast("info", "没有可重试的请求");
      return;
    }

    const kind =
      last && last.kind !== "auto"
        ? last.kind
        : /视频|短片|分镜|motion|video/i.test(prompt)
          ? "video"
          : "image";

    void handleGenerate({
      kind,
      prompt,
      ...(last?.aspectRatio ? { aspectRatio: last.aspectRatio } : {}),
      ...(last && last.attachments.length > 0 ? { attachments: last.attachments } : {}),
    });
  };

  const handleAddToCanvas = (block: ImageBlock) => {
    void canvasRef.current?.insertImage({
      url: block.url,
      name: block.prompt || "生成图像",
      mimeType: block.mimeType,
      width: block.width,
      height: block.height,
    });
  };

  const railProps = {
    projects: allProjects,
    activeId,
    onSelect: handleSelect,
    onCreate: handleCreate,
    onLogout: handleLogout,
    onCollapse: () => setRailOpen(false),
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas">
      {railOpen && (
        <div className="hidden shrink-0 lg:flex">
          <ProjectRail {...railProps} />
        </div>
      )}

      <div
        className={cn(
          "min-w-0 flex-1",
          mobileView === "canvas" ? "flex" : "hidden lg:flex",
        )}
      >
        <CanvasStage
          ref={canvasRef}
          project={activeProject}
          elements={data?.elements ?? []}
          files={data?.files ?? {}}
          loaded={data !== null}
          railCollapsed={!railOpen}
          onSave={handleSaveCanvas}
          onOpenProjects={() => {
            if (window.matchMedia("(min-width: 1024px)").matches) {
              setRailOpen(true);
            } else {
              setProjectsOpen(true);
            }
          }}
          onShowChat={() => setMobileView("chat")}
          onOpenMaterials={() => setMaterialPanel("manage")}
        />
      </div>

      <div
        className={cn(
          "w-full shrink-0 lg:w-auto",
          mobileView === "chat" ? "flex" : "hidden lg:flex",
        )}
      >
        <ChatPanel
          project={activeProject}
          messages={data?.messages ?? []}
          loading={
            Boolean(activeId) &&
            (loadingProject || (data === null && !loadingError))
          }
          loadingError={loadingError}
          onReload={() => setReloadToken((token) => token + 1)}
          sending={running}
          onCreate={handleCreate}
          onSend={handleSend}
          onStop={handleStop}
          onRetry={handleRetry}
          onAddToCanvas={handleAddToCanvas}
          onOpenMaterials={() => setMaterialPanel("select")}
          onOpenProjects={() => setProjectsOpen(true)}
          onShowCanvas={() => setMobileView("canvas")}
          composerRef={chatComposerRef}
        />
      </div>

      {projectsOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="关闭项目面板"
            onClick={() => setProjectsOpen(false)}
            className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]"
          />
          <div className="absolute inset-y-0 left-0 w-60 bg-canvas shadow-[0_0_40px_rgba(24,24,27,0.18)]">
            <ProjectRail {...railProps} onClose={() => setProjectsOpen(false)} />
          </div>
        </div>
      )}

      {materialPanel && (
        <MaterialLibraryPanel
          mode={materialPanel}
          onSelect={(material) => {
            chatComposerRef.current?.addMaterial(material);
            setMaterialPanel(null);
            setMobileView("chat");
          }}
          onClose={() => setMaterialPanel(null)}
        />
      )}
    </div>
  );
}