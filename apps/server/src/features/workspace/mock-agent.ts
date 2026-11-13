import { randomUUID } from "node:crypto";
import type {
  AgentReply,
  ImageBlock,
  InspirationBlock,
  InspirationItem,
  TextBlock,
  ToolBlock,
  VideoBlock,
} from "@my-lovart/shared";
import { env } from "../../lib/env.js";

const assetBase = env.webOrigins[0] ?? "http://localhost:3000";
const asset = (path: string) => `${assetBase}${path}`;

const MOCK_VIDEO_URL =
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";

const textBlock = (text: string): TextBlock => ({ type: "text", text });

const toolBlock = (tool: ToolBlock["tool"], title: string, detail: string): ToolBlock => ({
  type: "tool",
  id: randomUUID(),
  tool,
  status: "done",
  title,
  detail,
});

function imageReply(text: string): AgentReply {
  const content =
    "先按竖版海报给你一版方向：大留白、单色主视觉、标题压在下方。尺寸 2:3，主色 #1D1D1F，背景 #F5F5F7。";
  const image: ImageBlock = {
    type: "image",
    id: randomUUID(),
    url: asset("/mock/poster-1.svg"),
    mimeType: "image/svg+xml",
    width: 1024,
    height: 1536,
    prompt: text.slice(0, 80),
    model: "mock-image",
    aspectRatio: "2:3",
  };

  return {
    content,
    blocks: [
      textBlock(content),
      toolBlock("generate_image", "生成图像", "1024 × 1536 · mock-image"),
      image,
    ],
  };
}

function videoReply(text: string): AgentReply {
  const content =
    "分镜按 15 秒、6 个镜头处理：慢起、快切、定格收尾。先给你一版动态预览，后面可以逐镜头调。";
  const video: VideoBlock = {
    type: "video",
    id: randomUUID(),
    url: MOCK_VIDEO_URL,
    posterUrl: asset("/mock/video-poster.svg"),
    mimeType: "video/mp4",
    width: 1280,
    height: 720,
    durationSeconds: 15,
    prompt: text.slice(0, 80),
    model: "mock-video",
  };

  return {
    content,
    blocks: [
      textBlock(content),
      toolBlock("generate_video", "生成视频", "15s · 1280 × 720 · mock-video"),
      video,
    ],
  };
}

function inspirationReply(): AgentReply {
  const content =
    "找了几张同类方向的参考：构图偏中心、低饱和、文字少。可以挑一张作为整体基调。";
  const items: InspirationItem[] = [
    {
      id: randomUUID(),
      title: "编辑感留白",
      imageUrl: asset("/mock/insp-1.svg"),
      source: "Mock Gallery",
      width: 800,
      height: 600,
    },
    {
      id: randomUUID(),
      title: "网格与秩序",
      imageUrl: asset("/mock/insp-2.svg"),
      source: "Mock Gallery",
      width: 800,
      height: 600,
    },
    {
      id: randomUUID(),
      title: "大字排版",
      imageUrl: asset("/mock/insp-3.svg"),
      source: "Mock Gallery",
      width: 800,
      height: 600,
    },
    {
      id: randomUUID(),
      title: "空间与层次",
      imageUrl: asset("/mock/insp-4.svg"),
      source: "Mock Gallery",
      width: 800,
      height: 600,
    },
  ];
  const inspiration: InspirationBlock = {
    type: "inspiration",
    id: randomUUID(),
    query: "低饱和 · 编辑感 · 海报排版",
    items,
  };

  return {
    content,
    blocks: [
      textBlock(content),
      toolBlock("search_inspiration", "灵感搜索", "找到 4 条参考"),
      inspiration,
    ],
  };
}

export function buildMockReply(text: string): AgentReply {
  if (/视频|短片|分镜|motion|video/i.test(text)) return videoReply(text);
  if (/灵感|参考|搜索|案例|配色|inspiration|reference/i.test(text)) return inspirationReply();
  return imageReply(text);
}