"use client";

import { AlertCircle, Check, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info";
type ToastItem = { id: string; kind: ToastKind; text: string; leaving: boolean };

const ToastContext = createContext<(kind: ToastKind, text: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

const ICONS = {
  success: Check,
  error: AlertCircle,
  info: Info,
} as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, number>());

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, leaving: true } : item)),
      );
      window.setTimeout(() => remove(id), 180);
    },
    [remove],
  );

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = crypto.randomUUID();
      setItems((prev) => [...prev.slice(-3), { id, kind, text, leaving: false }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), 3600),
      );
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[min(92vw,360px)] flex-col gap-2"
      >
        {items.map((item) => {
          const Icon = ICONS[item.kind];
          return (
            <div
              key={item.id}
              role="status"
              className={`toast-item pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface px-3.5 py-3 text-[12px] leading-relaxed shadow-[0_18px_48px_-20px_rgba(24,24,27,0.45)] ${
                item.leaving ? "toast-leave" : "toast-enter"
              } ${
                item.kind === "error"
                  ? "border-danger/25"
                  : item.kind === "success"
                    ? "border-line"
                    : "border-line"
              }`}
            >
              <Icon
                className={`mt-0.5 size-3.5 shrink-0 ${
                  item.kind === "error"
                    ? "text-danger"
                    : item.kind === "success"
                      ? "text-accent"
                      : "text-muted"
                }`}
                strokeWidth={2}
              />
              <span className="min-w-0 flex-1 break-words text-ink">{item.text}</span>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label="关闭提示"
                className="-mr-1 -mt-1 grid size-5 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-canvas hover:text-ink"
              >
                <X className="size-3" strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}