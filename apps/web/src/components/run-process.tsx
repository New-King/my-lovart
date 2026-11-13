"use client";

import type { ChatMessage, RunStepStatus, ToolBlock } from "@my-lovart/shared";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Clapperboard,
  ImagePlus,
  Loader2,
  Search,
} from "lucide-react";
import { useEffect, useState } from "react";

const TOOL_ICONS = {
  generate_image: ImagePlus,
  generate_video: Clapperboard,
  search_inspiration: Search,
} as const;

function formatElapsed(from: string, to: string): string {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, (end - start) / 1000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function StepIcon({ status }: { status: RunStepStatus }) {
  if (status === "running") {
    return <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin text-ink" strokeWidth={2} />;
  }
  if (status === "failed") {
    return <AlertCircle className="mt-0.5 size-3 shrink-0 text-danger" strokeWidth={2} />;
  }
  if (status === "done") {
    return <Check className="mt-0.5 size-3 shrink-0 text-muted" strokeWidth={2.5} />;
  }
  return (
    <span className="mt-[3px] size-2.5 shrink-0 rounded-full border border-line bg-canvas" />
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <div className="h-1 w-28 overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full bg-ink transition-[width] duration-300 ease-out"
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
      <span className="font-mono text-[9.5px] tabular-nums text-faint">{Math.round(value)}%</span>
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolBlock }) {
  const Icon = TOOL_ICONS[tool.tool] ?? ImagePlus;
  const live = tool.status === "running" || tool.status === "queued";

  return (
    <div className="mt-2 rounded-lg border border-line/70 bg-canvas/60 px-2.5 py-2">
      <div className="flex items-center gap-2 text-[11px]">
        <Icon className="size-3.5 shrink-0 text-faint" strokeWidth={1.75} />
        <span className="min-w-0 truncate font-medium text-muted">{tool.title}</span>
        {tool.stage && <span className="shrink-0 text-faint">{tool.stage}</span>}
        <span className="ml-auto shrink-0">
          {tool.status === "failed" ? (
            <AlertCircle className="size-3 text-danger" strokeWidth={2} />
          ) : tool.status === "done" ? (
            <Check className="size-3 text-faint" strokeWidth={2.5} />
          ) : (
            <Loader2 className="size-3 animate-spin text-faint" strokeWidth={2} />
          )}
        </span>
      </div>

      {live && <ProgressBar value={tool.progress ?? 0} />}
      {!live && tool.detail && (
        <p className="mt-0.5 pl-[22px] text-[10px] text-faint">{tool.detail}</p>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 42;

  return (
    <div className="mt-2 border-t border-line/70 pt-2">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left text-[10px] text-faint transition-colors hover:text-muted"
      >
        <span>思考过程</span>
        {long && <span className="text-[9.5px]">{expanded ? "收起" : "展开"}</span>}
      </button>
      <p
        className={`mt-1 text-[11px] leading-relaxed text-muted ${
          expanded ? "" : "line-clamp-2"
        }`}
      >
        {text}
      </p>
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

  const [open, setOpen] = useState(live);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setOpen(live);
  }, [live]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  if (steps.length === 0 && tools.length === 0 && message.status !== "queued") return null;

  const doneCount = steps.filter((step) => step.status === "done").length;
  const lastFinished = steps.reduce<string | undefined>(
    (acc, step) =>
      step.finishedAt && (!acc || step.finishedAt > acc) ? step.finishedAt : acc,
    undefined,
  );
  const endedAt = message.updatedAt ?? lastFinished ?? message.createdAt;
  const elapsed = formatElapsed(
    message.createdAt,
    live ? new Date(now).toISOString() : endedAt,
  );
  const orphanTools = tools.filter((tool) => !tool.stepId || !steps.some((s) => s.id === tool.stepId));

  const title =
    message.status === "queued"
      ? message.queuePosition !== undefined && message.queuePosition > 0
        ? `排队中 · 第 ${message.queuePosition + 1} 位`
        : "排队中"
      : live
        ? "生成中"
        : failed
          ? "生成失败"
          : message.status === "canceled"
            ? "已停止"
            : "生成过程";

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {live ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted" strokeWidth={2} />
        ) : failed ? (
          <AlertCircle className="size-3 shrink-0 text-danger" strokeWidth={2} />
        ) : (
          <Check className="size-3 shrink-0 text-muted" strokeWidth={2.5} />
        )}
        <span className="text-[11.5px] font-medium text-muted">{title}</span>
        <span className="ml-auto shrink-0 font-mono text-[9.5px] tabular-nums text-faint">
          {steps.length > 0 ? `${doneCount}/${steps.length} 步 · ` : ""}
          {elapsed}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-faint transition-transform ${open ? "" : "-rotate-90"}`}
          strokeWidth={1.75}
        />
      </button>

      {open && (
        <div className="border-t border-line px-3 py-2.5">
          {steps.length === 0 && tools.length === 0 && message.status === "queued" && (
            <p className="py-0.5 text-[10.5px] text-faint">正在排队，轮到时自动开始…</p>
          )}
          {steps.length > 0 && (
            <ol className="space-y-2.5">
              {steps.map((step) => {
                const stepTools = tools.filter((tool) => tool.stepId === step.id);
                return (
                  <li key={step.id}>
                    <div className="flex items-start gap-2">
                      <StepIcon status={step.status} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[11.5px] leading-tight text-ink">{step.title}</p>
                        {step.detail && (
                          <p className="mt-0.5 break-words text-[10px] leading-relaxed text-faint">
                            {step.detail}
                          </p>
                        )}
                      </div>
                    </div>
                    {stepTools.map((tool) => (
                      <div key={tool.id} className="pl-5">
                        <ToolRow tool={tool} />
                      </div>
                    ))}
                  </li>
                );
              })}
            </ol>
          )}

          {orphanTools.length > 0 && (
            <div className={steps.length > 0 ? "mt-2.5" : ""}>
              {orphanTools.map((tool) => (
                <ToolRow key={tool.id} tool={tool} />
              ))}
            </div>
          )}

          {message.thinking && <Thinking text={message.thinking} />}
        </div>
      )}
    </section>
  );
}