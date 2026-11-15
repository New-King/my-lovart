import { randomUUID } from "node:crypto";
import { fileDataUrlFromUrl } from "../files/file.store.js";
import {
  CanvasConflictError,
  getWorkspaceRepository,
} from "../workspace/workspace.repository.js";
import { replaceCanvas } from "../workspace/workspace.store.js";

type CanvasElement = Record<string, unknown>;

export type InsertImageInput = {
  projectId: string;
  assetId: string;
  title: string;
  prompt: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  batchId?: string;
};

export type InsertImageResult = {
  elementId: string;
  placement: { x: number; y: number; width: number; height: number };
};

const MAX_WIDTH = 400;
const MAX_HEIGHT = 500;
const GAP = 24;
const ORIGIN = 56;

const locks = new Map<string, Promise<unknown>>();

function withCanvasLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  locks.set(projectId, next);
  return next.finally(() => {
    if (locks.get(projectId) === next) locks.delete(projectId);
  });
}

function fit(width: number, height: number) {
  if (width <= 0 || height <= 0) return { width: MAX_WIDTH, height: MAX_HEIGHT };
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function calculatePlacement(
  elements: CanvasElement[],
  width: number,
  height: number,
): InsertImageResult["placement"] {
  const visible = elements.filter((element) => element.isDeleted !== true);
  if (visible.length === 0) {
    return { x: ORIGIN, y: ORIGIN, width, height };
  }

  let maxRight = -Infinity;
  let rowCenter = ORIGIN + height / 2;
  for (const element of visible) {
    const right = (Number(element.x) || 0) + (Number(element.width) || 0);
    if (right > maxRight) {
      maxRight = right;
      rowCenter = (Number(element.y) || 0) + (Number(element.height) || 0) / 2;
    }
  }

  return {
    x: Math.round(maxRight + GAP),
    y: Math.round(rowCenter - height / 2),
    width,
    height,
  };
}

function buildImageElement(
  fileId: string,
  placement: InsertImageResult["placement"],
  input: InsertImageInput,
): CanvasElement {
  const now = Date.now();
  return {
    type: "image",
    id: `el-${randomUUID()}`,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
    fileId,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: null,
    boundElements: null,
    frameId: null,
    index: null,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    isDeleted: false,
    updated: now,
    link: null,
    locked: false,
    status: "saved",
    scale: [1, 1],
    crop: null,
    customData: {
      name: input.title,
      title: input.title,
      assetId: input.assetId,
      prompt: input.prompt.slice(0, 500),
      ...(input.batchId ? { batchId: input.batchId } : {}),
      source: "generated",
    },
  };
}

/**
 * 作业完成后由服务端直接把图片插进画布：用户关掉页面也能拿到结果。
 * 和前端自动插入互斥——工具结果会带 elementId，前端只刷新不重复插。
 */
export async function insertImageOnCanvas(
  input: InsertImageInput,
): Promise<InsertImageResult | null> {
  return withCanvasLock(input.projectId, async () => {
    const repo = await getWorkspaceRepository();
    if (!repo) return null;

    const dataURL = await fileDataUrlFromUrl(input.url);
    if (!dataURL) throw new Error("图片文件读不出来，无法上画布");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await repo.loadCanvas(input.projectId);
      const elements = [...snapshot.elements] as CanvasElement[];
      const files = { ...snapshot.files };
      const size = fit(input.width, input.height);
      const placement = calculatePlacement(elements, size.width, size.height);
      const fileId = input.assetId;

      files[fileId] = {
        id: fileId,
        mimeType: input.mimeType,
        dataURL,
        created: Date.now(),
        lastRetrieved: Date.now(),
      };

      const element = buildImageElement(fileId, placement, input);
      elements.push(element);
      try {
        const revision = await repo.saveCanvas(
          input.projectId,
          elements,
          files,
          snapshot.canvasRevision,
        );
        // 内存缓存和 DB 必须一起前进，否则下一轮 Agent 仍会看到空画布
        replaceCanvas(input.projectId, elements, files, revision);
        return { elementId: String(element.id), placement };
      } catch (err) {
        if (!(err instanceof CanvasConflictError) || attempt > 0) throw err;
        console.warn("[canvas] 画布刚被前端更新，重新计算位置后再插入");
      }
    }

    throw new CanvasConflictError();
  });
}