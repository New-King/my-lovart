"use client";

import { Frame, Menu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getHealth,
  type ChatAttachment,
  type ChatMessage,
  type Project,
} from "@/lib/api";
import { MessageAttachments } from "./chat-attachments";
import { ChatBlocks } from "./chat-blocks";
import { ChatComposer } from "./chat-composer";
import { ChatEmptyState } from "./chat-empty-state";
import { ImageLightbox } from "./image-lightbox";

type Props = {
  project: Project | null;
  messages: ChatMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  onCreate: () => void;
  onSend: (text: string, attachments: ChatAttachment[]) => Promise<boolean>;
  onOpenProjects: () => void;
  onShowCanvas: () => void;
};

export function ChatPanel({
  project,
  messages,
  loading,
  sending,
  error,
  onCreate,
  onSend,
  onOpenProjects,
  onShowCanvas,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  const [agent, setAgent] = useState<"mock" | "llm" | null>(null);

  useEffect(() => {
    getHealth()
      .then((health) => setAgent(health.agent))
      .catch(() => {});
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, sending]);

  const agentLabel = agent === "mock" ? "mock-agent" : agent === "llm" ? "deepseek-flash" : "agent";

  return (
    <section className="flex w-full shrink-0 flex-col bg-canvas lg:w-[360px] lg:border-l lg:border-line">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3 lg:px-4">
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={onOpenProjects}
            aria-label="打开项目"
            className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink lg:hidden"
          >
            <Menu className="size-4" strokeWidth={1.75} />
          </button>
          <span className="text-[13px] font-medium tracking-tight">对话</span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onShowCanvas}
            aria-label="打开画布"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] text-muted transition-colors hover:bg-surface hover:text-ink lg:hidden"
          >
            <Frame className="size-3.5" strokeWidth={1.75} />
            画布
          </button>
          <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] text-muted">
            {agentLabel}
          </span>
        </div>
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-5">
        {loading ? (
          <div className="grid h-full place-items-center text-[13px] text-faint">加载对话…</div>
        ) : messages.length === 0 ? (
          <ChatEmptyState
            hasProject={Boolean(project)}
            disabled={sending}
            onCreate={onCreate}
            onSend={(text) => void onSend(text, [])}
          />
        ) : (
          <div className="space-y-5">
            {messages.map((message) =>
              message.role === "user" ? (
                <div
                  key={message.id}
                  className="ml-auto max-w-[85%] rounded-xl border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed"
                >
                  {message.attachments && message.attachments.length > 0 && (
                    <div className={message.content ? "mb-2" : ""}>
                      <MessageAttachments
                        attachments={message.attachments}
                        onPreview={(attachment) =>
                          setPreview({ src: attachment.url, name: attachment.name })
                        }
                      />
                    </div>
                  )}
                  {message.content && (
                    <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  )}
                </div>
              ) : message.blocks && message.blocks.length > 0 ? (
                <ChatBlocks
                  key={message.id}
                  blocks={message.blocks}
                  onPreview={setPreview}
                />
              ) : (
                <div
                  key={message.id}
                  className="prose-muse text-[13.5px] leading-[1.7] text-ink"
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                </div>
              ),
            )}
            {sending && <p className="text-[13px] text-faint">思考中…</p>}
          </div>
        )}
      </div>

      <ChatComposer
        key={project?.id ?? "no-project"}
        disabled={!project || loading}
        sending={sending}
        error={error}
        placeholder={project ? "描述你想要的画面…" : "先新建一个项目"}
        onSend={onSend}
      />

      {preview && (
        <ImageLightbox
          src={preview.src}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}