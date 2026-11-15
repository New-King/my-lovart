"use client";

import type { ChoiceQuestion } from "@my-lovart/shared";
import { ChevronLeft, ChevronRight, MessageCircleQuestion } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Answer = { optionId?: string; custom?: string };

type Props = {
  questions: ChoiceQuestion[];
  disabled?: boolean;
  /** 返回 false 表示没发出去，卡片恢复可编辑以便重试 */
  onSubmit: (text: string) => Promise<boolean> | boolean | void;
};

const LETTERS = ["A", "B", "C", "D", "E"];

/**
 * 逐题提问卡：每个问题独立回答，可选项也可自定义。
 * 最多同时露出两组，答完一组自动滚到下一组。
 */
export function ClarificationCard({ questions, disabled = false, onSubmit }: Props) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [active, setActive] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const groupRefs = useRef<Array<HTMLDivElement | null>>([]);

  const answeredCount = useMemo(
    () =>
      questions.filter((question) => {
        const answer = answers[question.id];
        return Boolean(answer?.optionId || answer?.custom?.trim());
      }).length,
    [answers, questions],
  );

  const scrollToQuestion = (index: number) => {
    const container = scrollRef.current;
    const group = groupRefs.current[index];
    if (!container || !group) return;
    const containerRect = container.getBoundingClientRect();
    const groupRect = group.getBoundingClientRect();
    const top = groupRect.top - containerRect.top + container.scrollTop - 8;
    container.scrollTo({ top, behavior: "smooth" });
  };

  const goTo = (index: number) => {
    const next = Math.max(0, Math.min(index, questions.length - 1));
    setActive(next);
    scrollToQuestion(next);
  };

  const selectOption = (question: ChoiceQuestion, optionId: string) => {
    const nextAnswers: Record<string, Answer> = { ...answers, [question.id]: { optionId } };
    setAnswers(nextAnswers);
    const index = questions.findIndex((item) => item.id === question.id);
    const nextUnanswered = questions.findIndex(
      (item, itemIndex) =>
        itemIndex > index &&
        !nextAnswers[item.id]?.optionId &&
        !nextAnswers[item.id]?.custom?.trim(),
    );
    const target =
      nextUnanswered >= 0 ? nextUnanswered : Math.min(index + 1, questions.length - 1);
    if (target !== index) {
      window.setTimeout(() => goTo(target), 180);
    }
  };

  const setCustom = (question: ChoiceQuestion, value: string) => {
    setAnswers((prev) => ({
      ...prev,
      [question.id]: { custom: value },
    }));
  };

  const buildAnswerText = (): string => {
    const lines = questions
      .map((question, index) => {
        const answer = answers[question.id];
        if (!answer) return null;
        const option = question.options.find((item) => item.id === answer.optionId);
        const value = answer.custom?.trim() || option?.label;
        if (!value) return null;
        return `${index + 1}. ${question.question}：${value}`;
      })
      .filter((line): line is string => Boolean(line));
    if (lines.length === 0) return "这些问题先跳过，按你的判断先来一版。";
    return `我的回答：\n${lines.join("\n")}`;
  };

  const submit = async () => {
    if (disabled || submitted) return;
    if (answeredCount === 0) return;
    setSubmitted(true);
    try {
      const ok = await onSubmit(buildAnswerText());
      if (ok === false) setSubmitted(false);
    } catch {
      setSubmitted(false);
    }
  };

  const skip = async () => {
    if (disabled || submitted) return;
    if (active < questions.length - 1) {
      goTo(active + 1);
      return;
    }
    setSubmitted(true);
    try {
      const text =
        answeredCount === 0
          ? "这些问题先跳过，按你的判断先来一版。"
          : buildAnswerText();
      const ok = await onSubmit(text);
      if (ok === false) setSubmitted(false);
    } catch {
      setSubmitted(false);
    }
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_8px_30px_-24px_rgba(24,24,27,0.45)]",
        (disabled || submitted) && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2 border-b border-line/70 px-3.5 py-2.5">
        <MessageCircleQuestion className="size-3.5 text-muted" strokeWidth={1.8} />
        <span className="text-[11.5px] font-medium text-muted">提问</span>
        <div className="ml-auto flex items-center gap-1 text-[10.5px] text-faint">
          <button
            type="button"
            aria-label="上一题"
            disabled={active === 0}
            onClick={() => goTo(active - 1)}
            className="grid size-6 place-items-center rounded-md transition-colors hover:bg-canvas hover:text-ink disabled:opacity-30"
          >
            <ChevronLeft className="size-3.5" strokeWidth={2} />
          </button>
          <span className="tabular-nums">
            {active + 1} / {questions.length}
          </span>
          <button
            type="button"
            aria-label="下一题"
            disabled={active >= questions.length - 1}
            onClick={() => goTo(active + 1)}
            className="grid size-6 place-items-center rounded-md transition-colors hover:bg-canvas hover:text-ink disabled:opacity-30"
          >
            <ChevronRight className="size-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* 最多露出两组；多出来的在容器内滚动，答完自动滚到下一组 */}
      <div ref={scrollRef} className="max-h-[430px] overflow-y-auto px-3.5 py-2.5">
        <div className="space-y-4">
          {questions.map((question, questionIndex) => {
            const answer = answers[question.id] ?? {};
            return (
              <div
                key={question.id}
                ref={(node) => {
                  groupRefs.current[questionIndex] = node;
                }}
                className="space-y-2.5"
              >
                <p className="text-[13px] font-medium leading-snug text-ink">
                  {question.question}
                </p>

                <div className="space-y-1.5">
                  {question.options.map((option, optionIndex) => {
                    const selected = answer.optionId === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        disabled={disabled || submitted}
                        onClick={() => selectOption(question, option.id)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
                          selected
                            ? "border-accent/45 bg-accent-soft text-ink"
                            : "border-line/80 bg-canvas/40 text-muted hover:border-line hover:bg-canvas hover:text-ink",
                        )}
                      >
                        <span
                          className={cn(
                            "grid size-[18px] shrink-0 place-items-center rounded text-[10px] font-semibold",
                            selected
                              ? "bg-ink text-white"
                              : "bg-line/60 text-muted",
                          )}
                        >
                          {LETTERS[optionIndex] ?? optionIndex + 1}
                        </span>
                        <span className="min-w-0 flex-1 leading-snug">{option.label}</span>
                      </button>
                    );
                  })}

                  {question.allowCustom !== false && (
                    <label
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg border px-2.5 py-1 transition-colors",
                        answer.custom?.trim()
                          ? "border-accent/45 bg-accent-soft"
                          : "border-line/80 bg-canvas/40",
                      )}
                    >
                      <span className="grid size-[18px] shrink-0 place-items-center rounded bg-line/60 text-[10px] font-semibold text-muted">
                        {LETTERS[question.options.length] ?? question.options.length + 1}
                      </span>
                      <input
                        value={answer.custom ?? ""}
                        disabled={disabled || submitted}
                        onChange={(event) => setCustom(question, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing) return;
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void submit();
                          }
                        }}
                        placeholder="输入你自己的答案…"
                        className="min-w-0 flex-1 bg-transparent py-0.5 text-[12.5px] text-ink outline-none placeholder:text-faint"
                      />
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line/70 px-3.5 py-2.5">
        <button
          type="button"
          disabled={disabled || submitted}
          onClick={() => void skip()}
          className="h-8 rounded-lg border border-line px-3 text-[11.5px] text-muted transition-colors hover:bg-canvas hover:text-ink disabled:opacity-40"
        >
          跳过
        </button>
        <button
          type="button"
          disabled={disabled || submitted || answeredCount === 0}
          onClick={() => void submit()}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
        >
          提交
          <span className="text-[10px] opacity-70">↵</span>
        </button>
      </div>
    </div>
  );
}