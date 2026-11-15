"use client";

import { Check, ChevronDown, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useToast } from "./ui/toast";

const ISSUE_TYPES = [
  "没有遵循指令",
  "细节有错误或不准确",
  "不是我想要的风格",
  "和参考图差别太大",
  "等待时间太久",
  "消耗了太多积分",
] as const;

type Vote = "up" | "down" | null;

/** 大拇指按钮 + 深色悬停提示，提示文案和截图一致 */
function ThumbButton({
  label,
  active,
  expanded,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  expanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        aria-expanded={expanded}
        onClick={onClick}
        className={`peer grid size-7 place-items-center rounded-md transition-colors ${
          active ? "text-ink" : "text-faint hover:text-ink"
        }`}
      >
        {children}
      </button>
      <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-[11px] leading-none text-white opacity-0 transition-opacity duration-100 peer-hover:opacity-100 peer-focus-visible:opacity-100">
        {label}
      </span>
    </span>
  );
}

/**
 * 回答下方的评价条：假数据版本，只维护本地状态。
 * 点踩展开反馈表单，提交只弹 toast，不请求后端。
 */
export function MessageFeedback({
  messageId,
  onExpand,
}: {
  messageId: string;
  /** 展开反馈表单后通知外层滚到底，别让表单被挡在可视区下面 */
  onExpand?: () => void;
}) {
  const toast = useToast();
  const [vote, setVote] = useState<Vote>(null);
  const [open, setOpen] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const [types, setTypes] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const resetForm = () => {
    setOpen(false);
    setTypesOpen(false);
    setTypes([]);
    setNote("");
  };

  const handleUp = () => {
    resetForm();
    setSubmitted(false);
    setVote((value) => (value === "up" ? null : "up"));
  };

  const handleDown = () => {
    if (vote === "down") {
      resetForm();
      setSubmitted(false);
      setVote(null);
      return;
    }
    resetForm();
    setSubmitted(false);
    setVote("down");
    setOpen(true);
    onExpand?.();
  };

  const toggleType = (type: string) => {
    setTypes((prev) => (prev.includes(type) ? prev.filter((item) => item !== type) : [...prev, type]));
  };

  const cancel = () => {
    resetForm();
    setVote(null);
  };

  const submit = () => {
    resetForm();
    setSubmitted(true);
    toast("success", "感谢你提交反馈！");
  };

  return (
    <div className="pt-0.5">
      <div className="flex items-center gap-0.5">
        <ThumbButton label="有帮助" active={vote === "up"} onClick={handleUp}>
          <ThumbsUp
            className="size-4"
            strokeWidth={1.75}
            fill={vote === "up" ? "currentColor" : "none"}
          />
        </ThumbButton>
        <ThumbButton
          label="没帮助"
          active={vote === "down"}
          expanded={open}
          onClick={handleDown}
        >
          <ThumbsDown
            className="size-4"
            strokeWidth={1.75}
            fill={vote === "down" ? "currentColor" : "none"}
          />
        </ThumbButton>
        {submitted && vote === "down" && (
          <span className="ml-1 text-[11px] text-faint">已收到反馈</span>
        )}
      </div>

      {open && (
        <div className="mt-3" aria-label={`反馈 ${messageId}`}>
          <p className="text-[13px] font-medium text-ink">您觉得这个结果怎么样？</p>

          <div className="mt-2 rounded-xl border border-line bg-surface p-3.5">
            <div className="relative">
              <p className="mb-1.5 text-[12px] text-muted">
                问题类型 <span className="text-faint">（可选）</span>
              </p>
              <button
                type="button"
                aria-expanded={typesOpen}
                onClick={() => setTypesOpen((value) => !value)}
                className="flex h-9 w-full items-center justify-between gap-2 rounded-lg bg-canvas px-3 text-left text-[13px]"
              >
                <span className={`min-w-0 truncate ${types.length > 0 ? "text-ink" : "text-faint"}`}>
                  {types.length > 0 ? types.join("、") : "请选择"}
                </span>
                <ChevronDown
                  className={`size-3.5 shrink-0 text-faint transition-transform ${typesOpen ? "rotate-180" : ""}`}
                  strokeWidth={1.75}
                />
              </button>

              {typesOpen && (
                <div className="mt-1 max-h-56 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-[0_16px_40px_-24px_rgba(24,24,27,0.35)]">
                  {ISSUE_TYPES.map((type) => {
                    const checked = types.includes(type);
                    return (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={checked}
                        onClick={() => toggleType(type)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-canvas"
                      >
                        <span
                          className={`grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors ${
                            checked ? "border-ink bg-ink text-white" : "border-line bg-surface"
                          }`}
                        >
                          {checked && <Check className="size-2.5" strokeWidth={3} />}
                        </span>
                        <span className="min-w-0 truncate">{type}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <p className="mt-3 mb-1.5 text-[12px] text-muted">
              补充说明 <span className="text-faint">（可选）</span>
            </p>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value.slice(0, 100))}
              maxLength={100}
              placeholder="补充反馈"
              className="min-h-[88px] w-full resize-none rounded-lg bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-faint"
            />
            <p className="mt-1 text-right text-[11px] tabular-nums text-faint">{note.length}/100</p>

            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancel}
                className="h-8 rounded-lg border border-line bg-surface px-3 text-[12px] text-ink transition-colors hover:bg-canvas"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                className="h-8 rounded-lg bg-ink px-3 text-[12px] font-medium text-white transition-colors hover:bg-ink/90"
              >
                提交
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}