"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 聊天模型经常用单换行分点，而不是空行分段。
 * Markdown 会把单换行折叠成空格，看起来就全挤在一段里；
 * 这里给非空行补两个空格（Markdown 硬换行），代码块内保持原样。
 */
export function formatChatMarkdown(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced || !line.trim()) return line;
      if (/\s{2,}$/.test(line)) return line;
      return `${line}  `;
    })
    .join("\n");
}

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        table: ({ node: _node, ...props }) => (
          <div className="md-table-wrap">
            <table {...props} />
          </div>
        ),
      }}
    >
      {formatChatMarkdown(text)}
    </ReactMarkdown>
  );
}