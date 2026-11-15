"use client";

import { Check, Loader2, PanelLeftClose, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/api";

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86_400_000;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < day * 2) return "昨天";
  return `${Math.floor(diff / day)} 天前`;
}

type Props = {
  projects: Project[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onLogout: () => void;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose?: () => void;
  onCollapse?: () => void;
};

export function ProjectRail({
  projects,
  activeId,
  onSelect,
  onCreate,
  onLogout,
  onRename,
  onDelete,
  onClose,
  onCollapse,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const committing = useRef(false);
  const cancelEdit = useRef(false);

  useEffect(() => {
    if (!editingId) return;
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, [editingId]);

  const startRename = (project: Project) => {
    setConfirmId(null);
    cancelEdit.current = false;
    setEditingId(project.id);
    setDraftName(project.name);
  };

  const commitRename = async () => {
    const id = editingId;
    const name = draftName.trim();
    if (!id || committing.current || cancelEdit.current) return;
    if (!name) {
      setEditingId(null);
      return;
    }
    if (name === projects.find((p) => p.id === id)?.name) {
      setEditingId(null);
      return;
    }
    committing.current = true;
    setSaving(true);
    try {
      await onRename(id, name);
      setEditingId(null);
    } catch {
      // 失败时保持编辑态，让用户可以直接改
    } finally {
      committing.current = false;
      setSaving(false);
    }
  };

  const commitDelete = async (id: string) => {
    setSaving(true);
    try {
      await onDelete(id);
      setConfirmId(null);
    } catch {
      // 失败时保留确认态，用户可重试
    } finally {
      setSaving(false);
    }
  };
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-canvas">
      <div className="flex h-12 items-center gap-2 px-4">
        <span className="grid size-[22px] place-items-center rounded-[7px] bg-ink text-[11px] font-semibold text-canvas">
          m
        </span>
        <span className="text-[13px] font-medium tracking-tight">mylovart</span>
        {!onClose && onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="隐藏项目栏"
            title="隐藏项目栏"
            className="ml-auto grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <PanelLeftClose className="size-4" strokeWidth={1.75} />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭项目栏"
            className="ml-auto grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onCreate}
        className="mx-3 mt-1 flex h-9 items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted transition-colors hover:bg-surface hover:text-ink lg:h-8"
      >
        <Plus className="size-3.5" strokeWidth={2} />
        新建项目
      </button>

      <div className="px-4 pt-6 pb-1.5 text-[11px] tracking-[0.08em] text-faint">项目</div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {projects.length === 0 ? (
          <p className="px-2 py-1 text-[13px] leading-relaxed text-faint">
            还没有项目，点上面的「新建项目」开始。
          </p>
        ) : (
          projects.map((p) => {
            const draft = p.id.startsWith("draft-");
            const active = p.id === activeId;

            if (editingId === p.id) {
              return (
                <div
                  key={p.id}
                  className="mb-0.5 flex h-9 items-center gap-1 rounded-lg bg-surface px-1.5 shadow-[inset_0_0_0_1px_var(--color-line)] lg:h-8"
                >
                  <input
                    ref={inputRef}
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    maxLength={60}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") void commitRename();
                      if (event.key === "Escape") {
                        cancelEdit.current = true;
                        setEditingId(null);
                      }
                    }}
                    onBlur={() => {
                      if (cancelEdit.current) {
                        cancelEdit.current = false;
                        return;
                      }
                      void commitRename();
                    }}
                    className="h-6 min-w-0 flex-1 rounded-md bg-canvas px-1.5 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--color-line)] outline-none"
                  />
                  {saving ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted" />
                  ) : (
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void commitRename()}
                      aria-label="保存名称"
                      className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-canvas hover:text-ink"
                    >
                      <Check className="size-3.5" strokeWidth={2} />
                    </button>
                  )}
                </div>
              );
            }

            if (confirmId === p.id) {
              return (
                <div
                  key={p.id}
                  className="mb-0.5 flex h-9 items-center gap-1 rounded-lg bg-surface px-2 shadow-[inset_0_0_0_1px_var(--color-line)] lg:h-8"
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                    删除「{p.name}」？
                  </span>
                  <button
                    type="button"
                    onClick={() => void commitDelete(p.id)}
                    disabled={saving}
                    aria-label="确认删除"
                    className="grid size-6 shrink-0 place-items-center rounded-md text-danger hover:bg-danger/10 disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Check className="size-3.5" strokeWidth={2} />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    aria-label="取消删除"
                    className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-canvas hover:text-ink"
                  >
                    <X className="size-3.5" strokeWidth={2} />
                  </button>
                </div>
              );
            }

            return (
              <div
                key={p.id}
                className={`group relative mb-0.5 flex h-9 items-center rounded-lg lg:h-8 ${
                  active ? "bg-surface" : "hover:bg-surface/70"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(p.id)}
                  className={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[13px] ${
                    active ? "" : "text-muted transition-colors group-hover:text-ink"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="shrink-0 text-[11px] text-faint transition-opacity group-hover:opacity-0 max-sm:opacity-0">
                    {p.isDraft ? "未保存" : relativeTime(p.updatedAt)}
                  </span>
                </button>

                {!draft && (
                  <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 max-sm:opacity-100">
                    <button
                      type="button"
                      onClick={() => startRename(p)}
                      aria-label={`重命名 ${p.name}`}
                      title="重命名"
                      className="grid size-6 place-items-center rounded-md text-muted transition-colors hover:bg-canvas hover:text-ink"
                    >
                      <Pencil className="size-3" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmId(p.id)}
                      aria-label={`删除 ${p.name}`}
                      title="删除"
                      className="grid size-6 place-items-center rounded-md text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="size-3" strokeWidth={1.75} />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </nav>

      <button
        type="button"
        onClick={onLogout}
        className="flex items-center gap-2 border-t border-line px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] text-left transition-colors hover:bg-surface lg:pb-3"
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-medium text-accent">
          N
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">退出登录</span>
      </button>
    </aside>
  );
}