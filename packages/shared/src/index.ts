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
export type ToolStatus = "queued" | "running" | "done" | "failed";

export type ToolBlock = {
  type: "tool";
  id: string;
  tool: ToolName;
  status: ToolStatus;
  title: string;
  detail?: string;
  /** 关联到哪一步；界面用它把工具挂在对应步骤下 */
  stepId?: string;
  /** 0–100，真实任务只有这个粒度 */
  progress?: number;
  /** 排队中 / 扩散中 / 编码中 这类人话阶段 */
  stage?: string;
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

export type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  /** 服务端文件地址；本地预览阶段是 data URL */
  url: string;
  size: number;
  width?: number;
  height?: number;
};

export type StepKind =
  | "understand"
  | "plan"
  | "generate"
  | "compose"
  | "search"
  | "reply";

export type RunStepStatus = "pending" | "running" | "done" | "failed";

export type RunStep = {
  id: string;
  kind: StepKind;
  title: string;
  status: RunStepStatus;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type RunError = {
  /** 机器可读：provider_timeout / rate_limited / content_blocked / aborted … */
  code: string;
  message: string;
  retriable: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  updatedAt?: string;
  /** 助手消息的运行状态；用户消息不填 */
  status?: "queued" | "streaming" | "completed" | "canceled" | "failed";
  error?: string;
  /** 失败时带回结构化原因，界面据此决定是否给重试 */
  failure?: RunError;
  /** 这次运行经历了哪些步骤 */
  steps?: RunStep[];
  /** 排队时在队列里的位置，0 表示即将开始 */
  queuePosition?: number;
  /** 思考过程的增量拼接结果 */
  thinking?: string;
  attachments?: ChatAttachment[];
  blocks?: ChatBlock[];
};

export type AspectRatio = "1:1" | "4:3" | "3:4" | "16:9" | "9:16";

/** 客户端要求服务端启动一次生成。 */
export type GenerateRequest = {
  kind: "image" | "video";
  prompt: string;
  aspectRatio?: AspectRatio;
  /** 参考图，复用附件结构；url 可以是 data URL 或服务端地址 */
  attachments?: ChatAttachment[];
};

export type Artifact = ImageBlock | VideoBlock | InspirationBlock;

/**
 * 服务端 → 客户端的一次运行事件。
 * 所有事件共享 seq/at：seq 单调递增，客户端发现跳号就知道丢了事件；
 * at 用于还原每一步的耗时。传输层（SSE / WS）只决定怎么送，不改变形状。
 */
type RunEventBase = {
  runId: string;
  messageId: string;
  seq: number;
  at: string;
};

export type RunEvent =
  | (RunEventBase & { type: "run.accepted"; queuePosition?: number })
  | (RunEventBase & { type: "run.started" })
  | (RunEventBase & { type: "step.started"; step: RunStep })
  | (RunEventBase & {
      type: "step.updated";
      stepId: string;
      status?: RunStepStatus;
      detail?: string;
    })
  | (RunEventBase & { type: "thinking.delta"; delta: string })
  | (RunEventBase & { type: "message.delta"; delta: string })
  | (RunEventBase & { type: "tool.started"; tool: ToolBlock })
  | (RunEventBase & {
      type: "tool.progress";
      toolCallId: string;
      progress?: number;
      stage?: string;
    })
  | (RunEventBase & {
      type: "tool.completed";
      toolCallId: string;
      outputSummary?: string;
    })
  | (RunEventBase & { type: "tool.failed"; toolCallId: string; error: RunError })
  | (RunEventBase & { type: "artifact.ready"; artifact: Artifact })
  | (RunEventBase & { type: "canvas.sync"; artifactId: string })
  | (RunEventBase & { type: "run.completed" })
  | (RunEventBase & { type: "run.canceled" })
  | (RunEventBase & { type: "run.failed"; error: RunError });