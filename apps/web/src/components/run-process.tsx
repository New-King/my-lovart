"use client";

import type { ChatMessage, Thought, ToolBlock } from "@my-lovart/shared";
import {
  AlertCircle,
  ChevronDown,
  Clapperboard,
  FileSearch,
  ImagePlus,
  Lightbulb,
  ListChecks,
  Loader2,
  Move,
  Search,
  ScanEye,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

const TOOL_ICONS = {
  generate_image: ImagePlus,
  generate_video: Clapperboard,
  manipulate_canvas: Move,
  inspect_canvas: ScanEye,
  offer_choices: ListChecks,
  list_assets: FileSearch,
  get_asset: FileSearch,
  search_inspiration: Search,
} as const;

function formatDuration(start: string, end: string | undefined, now: number): string {
  const from = new Date(start).getTime();
  const to = end ? new Date(end).getTime() : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "";
  const seconds = Math.max(0, (to - from) / 1000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

type Entry =
  | { kind: "thought"; id: string; at: string; thought: Thought }
  | { kind: "tool"; id: string; at: string; tool: ToolBlock };

function ThoughtRow({ thought, now }: { thought: Thought; now: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 py-1 text-left text-[11px] text-muted transition-colors hover:text-ink"
      >
        <Lightbulb className="size-3 shrink-0 text-faint" strokeWidth={1.75} />
        <span className="shrink-0">思考过程</span>
        <span className="shrink-0 text-faint">
          · {formatDuration(thought.startedAt, thought.finishedAt, now)}
        </span>
        <ChevronDown
          className={`ml-auto size-3 shrink-0 text-faint transition-transform ${
            expanded ? "" : "-rotate-90"
          }`}
          strokeWidth={1.75}
        />
      </button>
      {expanded && (
        <p className="mb-2 ml-5 whitespace-pre-wrap text-[11px] leading-relaxed text-muted">
          {thought.text || "—"}
        </p>
      )}
    </div>
  );
}

function ToolRow({ tool, now }: { tool: ToolBlock; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICONS[tool.tool] ?? ImagePlus;
  const live = tool.status === "running" || tool.status === "queued";
  const failed = tool.status === "failed";

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 py-1 text-left text-[11px] text-muted transition-colors hover:text-ink"
      >
        <Icon
          className={`size-3 shrink-0 ${failed ? "text-danger" : "text-faint"}`}
          strokeWidth={1.75}
        />
        <span className="shrink-0">{tool.title}</span>
        <span className="min-w-0 flex-1 truncate text-faint">· {tool.detail}</span>
        {live ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-faint" strokeWidth={2} />
        ) : (
          <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-faint">
            {tool.startedAt
              ? formatDuration(tool.startedAt, tool.finishedAt, now)
              : ""}
          </span>
        )}
        <ChevronDown
          className={`size-3 shrink-0 text-faint transition-transform ${
            expanded ? "" : "-rotate-90"
          }`}
          strokeWidth={1.75}
        />
      </button>
      {expanded && (
        <p
          className={`mb-2 ml-5 break-words text-[10.5px] leading-relaxed ${
            failed ? "text-danger" : "text-faint"
          }`}
        >
          {tool.detail || "—"}
        </p>
      )}
    </div>
  );
}

export function RunProcess({ message }: { message: ChatMessage }) {
  const live = message.status === "queued" || message.status === "streaming";
  const failed = message.status === "failed";
  const steps = message.steps ?? [];
  const tools = (message.blocks ?? []).filter(
    (block): block is ToolBlock => block.type === "tool",
  );
  const thoughts = message.thoughts ?? [];

  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  if (
    thoughts.length === 0 &&
    tools.length === 0 &&
    message.status !== "queued"
  ) {
    return null;
  }

  const runningTool = tools.find(
    (tool) => tool.status === "running" || tool.status === "queued",
  );
  const runningStep = [...steps].reverse().find((step) => step.status === "running");

  const title =
    message.status === "queued"
      ? message.queuePosition !== undefined && message.queuePosition > 0
        ? `排队中 · 第 ${message.queuePosition + 1} 位`
        : "排队中"
      : failed
        ? "生成失败"
        : message.status === "canceled"
          ? "已停止"
          : live
            ? runningTool
              ? `正在${runningTool.title}`
              : runningStep
                ? `正在${runningStep.title}`
                : "思考中"
            : "思考过程";

  const total = formatDuration(
    message.createdAt,
    live ? undefined : (message.updatedAt ?? message.createdAt),
    now,
  );

  const entries: Entry[] = [
    ...thoughts.map<Entry>((thought) => ({
      kind: "thought",
      id: thought.id,
      at: thought.startedAt,
      thought,
    })),
    ...tools.map<Entry>((tool) => ({
      kind: "tool",
      id: tool.id,
      at: tool.startedAt ?? message.createdAt,
      tool,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-0.5 text-left text-[11.5px] text-muted transition-colors hover:text-ink"
      >
        <span className="grid size-3.5 shrink-0 place-items-center">
          {live ? (
            <Loader2 className="size-3 animate-spin text-muted" strokeWidth={2} />
          ) : failed ? (
            <AlertCircle className="size-3 text-danger" strokeWidth={2} />
          ) : (
            <Lightbulb className="size-3 text-faint" strokeWidth={1.75} />
          )}
        </span>

        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={title}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="truncate"
          >
            {title}
          </motion.span>
        </AnimatePresence>

        <span className="shrink-0 text-faint">· {total}</span>
        <ChevronDown
          className={`ml-auto size-3.5 shrink-0 text-faint transition-transform ${
            open ? "" : "-rotate-90"
          }`}
          strokeWidth={1.75}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 border-l border-line pl-3">
              {entries.length === 0 ? (
                <p className="py-1 text-[10.5px] text-faint">
                  {message.status === "queued" ? "正在排队，轮到时自动开始…" : "暂无过程记录"}
                </p>
              ) : (
                entries.map((entry) =>
                  entry.kind === "thought" ? (
                    <ThoughtRow key={`t-${entry.id}`} thought={entry.thought} now={now} />
                  ) : (
                    <ToolRow key={`s-${entry.id}`} tool={entry.tool} now={now} />
                  ),
                )
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}