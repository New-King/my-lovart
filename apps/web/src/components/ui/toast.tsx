"use client";

import { AlertCircle, Check } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info";
type ToastItem = { id: string; kind: ToastKind; text: string };

const ToastContext = createContext<(kind: ToastKind, text: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = crypto.randomUUID();
    setItems((prev) => [...prev.slice(-2), { id, kind, text }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, 2600);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[100] flex flex-col items-center gap-2 px-4">
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            className="flex max-w-[min(92vw,420px)] items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 text-[12px] text-ink shadow-[0_16px_40px_-18px_rgba(24,24,27,0.4)]"
          >
            {item.kind === "error" ? (
              <AlertCircle className="size-3.5 shrink-0 text-danger" strokeWidth={2} />
            ) : item.kind === "success" ? (
              <Check className="size-3.5 shrink-0 text-accent" strokeWidth={2.25} />
            ) : null}
            <span className="min-w-0 break-words">{item.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}