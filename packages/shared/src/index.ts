export const APP_NAME = "My Lovart";

/**
 * 对话消息里的内容块。
 * 当前 HTTP 一次返回整条消息，放在 message.blocks；
 * 以后接流式时，用 ServerEvent 里的 block 事件增量下发同一套结构。
 */
export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolName = "generate_image" | "generate_video" | "search_inspiration";
export type ToolStatus = "running" | "done" | "failed";

export type ToolBlock = {
  type: "tool";
  id: string;
  tool: ToolName;
  status: ToolStatus;
  title: string;
  detail?: string;
};

export type ImageBlock = {
  type: "image";
  id: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
};

export type VideoBlock = {
  type: "video";
  id: string;
  url: string;
  posterUrl?: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds?: number;
  prompt?: string;
  model?: string;
};

export type InspirationItem = {
  id: string;
  title: string;
  imageUrl: string;
  source: string;
  sourceUrl?: string;
  width?: number;
  height?: number;
};

export type InspirationBlock = {
  type: "inspiration";
  id: string;
  query: string;
  items: InspirationItem[];
};

export type ChatBlock = TextBlock | ToolBlock | ImageBlock | VideoBlock | InspirationBlock;

export type AgentReply = {
  content: string;
  blocks: ChatBlock[];
};

/** 服务端 → 客户端的事件，WebSocket 复用同一套定义。 */
export type ServerEvent =
  | { type: "token"; runId: string; text: string }
  | { type: "tool.start"; runId: string; tool: string; input: unknown }
  | { type: "tool.end"; runId: string; tool: string; ok: boolean; output?: unknown }
  | { type: "block"; runId: string; block: ChatBlock }
  | { type: "canvas.sync"; projectId: string }
  | { type: "run.completed"; runId: string }
  | { type: "run.failed"; runId: string; message: string };

/** 客户端 → 服务端。 */
export type ClientEvent = { type: "agent.run"; projectId: string; sessionId: string; text: string };