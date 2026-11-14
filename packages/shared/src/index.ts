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

export type ToolName =
  | "generate_image"
  | "generate_video"
  | "manipulate_canvas"
  | "inspect_canvas"
  | "offer_choices"
  | "list_assets"
  | "get_asset"
  | "search_inspiration";
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
  startedAt?: string;
  finishedAt?: string;
  aspectRatio?: AspectRatio;
  /** 0–100，内部用于骨架阶段判断；界面不显示文字 */
  progress?: number;
  /** 排队中 / 扩散中 / 编码中 这类机器阶段，仅日志用 */
  stage?: string;
};

export type ImageBlock = {
  type: "image";
  id: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  /** 生成时模型给这张图起的短标题，跨轮引用用 */
  title?: string;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  /** 图生图/参考图来源的稳定 id，不是画布 elementId */
  sourceAssetIds?: string[];
  /** 服务端已落画布时的元素 id；前端据此只刷新，不重复插入 */
  elementId?: string;
  placement?: { x: number; y: number; width: number; height: number };
  /** 同一次工具调用产出的资源共用一个批次，界面按批次排成一行 */
  batchId?: string;
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
  title?: string;
  prompt?: string;
  model?: string;
  sourceAssetIds?: string[];
  batchId?: string;
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
  batchId?: string;
};

export type ChatBlock = TextBlock | ToolBlock | ImageBlock | VideoBlock | InspirationBlock;

/** 画布元素操作：服务端只描述意图，前端在 Excalidraw 上执行 */
export type CanvasAlignEdge = "left" | "right" | "top" | "bottom" | "centerX" | "centerY";

export type CanvasCommand =
  | { op: "move"; ids: string[]; x?: number; y?: number; dx?: number; dy?: number }
  | { op: "resize"; ids: string[]; width?: number; height?: number; scale?: number }
  | { op: "delete"; ids: string[] }
  | { op: "align"; ids: string[]; edge: CanvasAlignEdge }
  | { op: "distribute"; ids: string[]; axis: "horizontal" | "vertical" }
  | { op: "reorder"; ids: string[]; to: "front" | "back" }
  | { op: "opacity"; ids: string[]; opacity: number }
  | { op: "arrange" };

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
  /** 生成作业超时时带回，前端继续轮询，结果会自动上画布 */
  jobId?: string;
  jobType?: "image_generation" | "video_generation";
};

/** 一次运行里的一段思考；长任务会有多段，不是一份。 */
export type Thought = {
  id: string;
  text: string;
  startedAt: string;
  finishedAt?: string;
};

/** 消息里有顺序的内容：文字和产物按到达时间交错，而不是文字全在上、图片全在下。 */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "block"; block: ChatBlock };

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
  /** 多段思考，按开始时间排序 */
  thoughts?: Thought[];
  attachments?: ChatAttachment[];
  blocks?: ChatBlock[];
  /** 有序内容；老消息没有这个字段时前端回退到 content + blocks */
  parts?: MessagePart[];
  /** 助手这一轮给出的快捷选项，用户点一下就把选项原文发回去 */
  options?: string[];
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
  | (RunEventBase & {
      type: "thinking.started";
      thoughtId: string;
      startedAt: string;
    })
  | (RunEventBase & { type: "thinking.delta"; thoughtId: string; delta: string })
  | (RunEventBase & { type: "thinking.completed"; thoughtId: string })
  | (RunEventBase & { type: "message.delta"; delta: string })
  | (RunEventBase & { type: "message.options"; options: string[] })
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
  | (RunEventBase & { type: "canvas.command"; commands: CanvasCommand[] })
  | (RunEventBase & { type: "canvas.sync"; artifactId: string })
  | (RunEventBase & { type: "run.completed" })
  | (RunEventBase & { type: "run.canceled" })
  | (RunEventBase & { type: "run.failed"; error: RunError });