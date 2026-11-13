"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/auth";
import { CanvasStage } from "./canvas-stage";
import { ChatPanel } from "./chat-panel";
import { ProjectRail } from "./project-rail";
import {
  createProject,
  getWorkspace,
  listProjects,
  saveCanvas,
  sendMessage,
  type ChatAttachment,
  type Project,
  type WorkspaceData,
} from "@/lib/api";

const DRAFT_PREFIX = "draft-";
const IMAGE_ONLY_PROMPT = "看看这些参考图，给我一些具体的建议。";

function withAttachments(
  workspace: WorkspaceData,
  prompt: string,
  attachments: ChatAttachment[],
): WorkspaceData {
  if (attachments.length === 0) return workspace;

  for (let index = workspace.messages.length - 1; index >= 0; index -= 1) {
    const message = workspace.messages[index];
    if (message?.role === "user" && message.content === prompt) {
      return {
        ...workspace,
        messages: workspace.messages.map((item, itemIndex) =>
          itemIndex === index ? { ...item, attachments } : item,
        ),
      };
    }
  }

  return workspace;
}

export function Workspace() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"chat" | "canvas">("chat");
  const [projectsOpen, setProjectsOpen] = useState(false);
  const skipLoadFor = useRef<string | null>(null);

  const refreshProjects = useCallback(async () => {
    const list = await listProjects().catch(() => []);
    setProjects(list);
    return list;
  }, []);

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
    getWorkspace(activeId)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  /** 草稿在第一次真正产生内容时才落库，避免点一下「新建」就多一个空项目 */
  const ensureProject = useCallback(
    async (name?: string): Promise<string> => {
      if (!activeId) throw new Error("没有选中的项目");
      if (!activeId.startsWith(DRAFT_PREFIX)) return activeId;

      const created = await createProject(name ?? "未命名项目");
      setProjects((prev) => [created, ...prev]);
      setDraftId(null);
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

  const handleLogout = async () => {
    setProjectsOpen(false);
    await signOut();
    router.push("/");
  };

  const handleCreate = () => {
    setProjectsOpen(false);
    if (draftId) {
      setActiveId(draftId);
      return;
    }
    const id = `${DRAFT_PREFIX}${crypto.randomUUID()}`;
    setDraftId(id);
    setActiveId(id);
    setData({ projectId: id, elements: [], files: {}, messages: [] });
  };

  const handleSelect = (id: string) => {
    setProjectsOpen(false);
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
  const activeProject = allProjects.find((p) => p.id === activeId) ?? null;

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
        setError("画布保存失败");
      }
    },
    [activeId, ensureProject],
  );

  const handleSend = async (
    text: string,
    attachments: ChatAttachment[] = [],
  ): Promise<boolean> => {
    if (!activeId || sending) return false;

    const trimmed = text.trim();
    const prompt = trimmed || (attachments.length > 0 ? IMAGE_ONLY_PROMPT : "");
    if (!prompt) return false;

    setSending(true);
    setError(null);

    const optimistic = {
      id: `local-${Date.now()}`,
      role: "user" as const,
      content: trimmed || prompt,
      createdAt: new Date().toISOString(),
      attachments,
    };
    setData((prev) => (prev ? { ...prev, messages: [...prev.messages, optimistic] } : prev));

    try {
      // 第一句话就是项目名，避免左栏堆一排「未命名项目」
      const projectId = await ensureProject(prompt.slice(0, 18));
      const updated = await sendMessage(projectId, prompt);
      setData(withAttachments(updated, prompt, attachments));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败");
      setData((prev) =>
        prev ? { ...prev, messages: prev.messages.filter((m) => m.id !== optimistic.id) } : prev,
      );
      return false;
    } finally {
      setSending(false);
    }
  };

  const railProps = {
    projects: allProjects,
    activeId,
    onSelect: handleSelect,
    onCreate: handleCreate,
    onLogout: handleLogout,
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas">
      <div className="hidden shrink-0 lg:flex">
        <ProjectRail {...railProps} />
      </div>

      <div
        className={cn(
          "min-w-0 flex-1",
          mobileView === "canvas" ? "flex" : "hidden lg:flex",
        )}
      >
        <CanvasStage
          project={activeProject}
          elements={data?.elements ?? []}
          files={data?.files ?? {}}
          loaded={data !== null}
          onSave={handleSaveCanvas}
          onOpenProjects={() => setProjectsOpen(true)}
          onShowChat={() => setMobileView("chat")}
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
          loading={data === null}
          sending={sending}
          error={error}
          onCreate={handleCreate}
          onSend={handleSend}
          onOpenProjects={() => setProjectsOpen(true)}
          onShowCanvas={() => setMobileView("canvas")}
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
    </div>
  );
}