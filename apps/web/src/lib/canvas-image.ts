import {
  convertToExcalidrawElements,
  getCommonBounds,
  sceneCoordsToViewportCoords,
} from "@excalidraw/excalidraw";
import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

export type CanvasImagePlacement = { x: number; y: number };

export type CanvasImageInput = {
  url: string;
  name: string;
  mimeType?: string;
  width?: number;
  height?: number;
  placement?: CanvasImagePlacement;
  /** 同批次的图片会排在同一行；不传则单独占一行 */
  batchId?: string;
  /** 产物账本 id，和画布 elementId 不是一回事 */
  assetId?: string;
  title?: string;
  prompt?: string;
};

type ImageDataInput = {
  dataURL: string;
  mimeType: string;
  name: string;
  width?: number;
  height?: number;
  placement?: CanvasImagePlacement;
  batchId?: string;
  assetId?: string;
  title?: string;
  prompt?: string;
};

/**
 * 尺寸是固定的场景单位，不随窗口宽度或 zoom 变化：
 * 整个项目里的图片保持同一世界尺度，缩放画布时一起变大变小。
 */
const IMAGE_MAX_WIDTH = 400;
const IMAGE_MAX_HEIGHT = 500;
const ROW_GAP = 24;
const ROW_GAP_Y = 32;
/** 新内容从画布原点 + 边距开始，不跟随当前视口 */
const ORIGIN_X = 56;
const ORIGIN_Y = 56;

type RowSlot = { cursorX: number; y: number };
type SceneElementLike = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  version: number;
  versionNonce: number;
  updated: number;
  customData?: Record<string, unknown> | null;
};

/** 每块画布各自维护「批次 → 当前行」的游标 */
const batchRowsByApi = new WeakMap<object, Map<string, RowSlot>>();

function rowsFor(api: ExcalidrawImperativeAPI) {
  let rows = batchRowsByApi.get(api);
  if (!rows) {
    rows = new Map<string, RowSlot>();
    batchRowsByApi.set(api, rows);
  }
  return rows;
}

function fitSize(width: number, height: number) {
  const scale = Math.min(1, IMAGE_MAX_WIDTH / width, IMAGE_MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function liveElements(api: ExcalidrawImperativeAPI) {
  return api.getSceneElements().filter((element) => !element.isDeleted);
}

/** 只平移不改缩放，把目标区域放到视口附近 */
function panToRect(
  api: ExcalidrawImperativeAPI,
  rect: { x: number; y: number; width: number; height: number },
) {
  const appState = api.getAppState();
  const zoom = appState.zoom?.value && appState.zoom.value > 0.05 ? appState.zoom.value : 1;
  api.updateScene({
    appState: {
      scrollX: appState.width / (2 * zoom) - (rect.x + rect.width / 2),
      scrollY: appState.height / (2 * zoom) - (rect.y + rect.height / 2),
    },
  });
}

function isVisible(api: ExcalidrawImperativeAPI, element: SceneElementLike) {
  const appState = api.getAppState();
  const topLeft = sceneCoordsToViewportCoords(
    { sceneX: element.x, sceneY: element.y },
    appState,
  );
  const bottomRight = sceneCoordsToViewportCoords(
    { sceneX: element.x + element.width, sceneY: element.y + element.height },
    appState,
  );
  const padding = 48;
  return (
    bottomRight.x > padding &&
    topLeft.x < appState.width - padding &&
    bottomRight.y > padding &&
    topLeft.y < appState.height - padding
  );
}

/** 新元素落在视口外时平移过去，保持当前缩放 */
function ensureElementVisible(api: ExcalidrawImperativeAPI, element: SceneElementLike) {
  if (!isVisible(api, element)) panToRect(api, element);
}

/**
 * 把画布上的图片按批次重排成一行行：同批次的图片并排，
 * 新批次另起一行。用于修复历史上叠在一起的生成结果。
 */
export function arrangeCanvasImages(api: ExcalidrawImperativeAPI) {
  const scene = api.getSceneElements() as unknown as SceneElementLike[];
  const images = scene.filter((element) => element.type === "image" && !element.isDeleted);
  if (images.length === 0) return 0;

  const groups: SceneElementLike[][] = [];
  const groupIndexByBatch = new Map<string, number>();
  let loose: SceneElementLike[] = [];

  for (const image of images) {
    const batchId = image.customData?.batchId;
    if (typeof batchId === "string" && batchId) {
      const existing = groupIndexByBatch.get(batchId);
      if (existing !== undefined) {
        groups[existing]?.push(image);
      } else {
        groupIndexByBatch.set(batchId, groups.length);
        groups.push([image]);
      }
    } else {
      loose.push(image);
      if (loose.length === 3) {
        groups.push(loose);
        loose = [];
      }
    }
  }
  if (loose.length > 0) groups.push(loose);

  const placements = new Map<string, { x: number; y: number }>();

  let rowY = ORIGIN_Y;
  for (const group of groups) {
    let rowX = ORIGIN_X;
    let rowHeight = 0;
    for (const image of group) {
      // 整理只挪位置，不改变图片本身尺寸
      placements.set(image.id, { x: rowX, y: rowY });
      rowX += image.width + ROW_GAP;
      rowHeight = Math.max(rowHeight, image.height);
    }
    rowY += rowHeight + ROW_GAP_Y;
  }

  const nextElements = scene.map((element) => {
    const next = placements.get(element.id);
    if (!next) return element;
    return {
      ...element,
      x: next.x,
      y: next.y,
      version: element.version + 1,
      versionNonce: Math.floor(Math.random() * 2_000_000_000),
      updated: Date.now(),
    };
  });

  batchRowsByApi.delete(api);
  api.updateScene({
    elements: nextElements as never[],
    captureUpdate: "IMMEDIATELY",
  });

  const first = (nextElements as unknown as SceneElementLike[]).find(
    (element) => element.type === "image" && !element.isDeleted,
  );
  if (first) ensureElementVisible(api, first);
  return images.length;
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("图片读取失败"));
    };
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

function loadImageSize(dataURL: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      });
    image.onerror = () => reject(new Error("图片无法读取"));
    image.src = dataURL;
  });
}

export function loadImageDataUrlSize(
  dataURL: string,
): Promise<{ width: number; height: number }> {
  return loadImageSize(dataURL);
}

async function insertImageData(
  api: ExcalidrawImperativeAPI,
  input: ImageDataInput,
): Promise<void> {
  const natural =
    input.width && input.height
      ? { width: input.width, height: input.height }
      : await loadImageSize(input.dataURL);

  const { width, height } = fitSize(natural.width, natural.height);

  let x: number;
  let y: number;

  if (input.placement) {
    x = input.placement.x - width / 2;
    y = input.placement.y - height / 2;
  } else {
    let appState = api.getAppState();
    for (let index = 0; index < 20 && (appState.width === 0 || appState.height === 0); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      appState = api.getAppState();
    }

    const rows = rowsFor(api);
    let row = input.batchId ? rows.get(input.batchId) : undefined;

    if (row) {
      // 同批次继续往右排，顶部对齐
      x = row.cursorX;
      y = row.y;
    } else {
      const images = liveElements(api).filter((element) => element.type === "image");
      if (images.length === 0) {
        // 空白画布 → 从画布原点开始，位置稳定不跟视口跑
        x = ORIGIN_X;
        y = ORIGIN_Y;
      } else {
        // 已有图片 → 新批次另起一行，接在所有图片下方
        const [, , , bottom] = getCommonBounds(images);
        x = ORIGIN_X;
        y = (Number.isFinite(bottom) ? bottom : ORIGIN_Y) + ROW_GAP_Y;
      }

      if (input.batchId) {
        row = { cursorX: x, y };
        rows.set(input.batchId, row);
      }
    }

    if (row) row.cursorX = x + width + ROW_GAP;
  }

  const fileId = crypto.randomUUID() as BinaryFileData["id"];
  const file: BinaryFileData = {
    id: fileId,
    mimeType: input.mimeType as BinaryFileData["mimeType"],
    dataURL: input.dataURL as DataURL,
    created: Date.now(),
    lastRetrieved: Date.now(),
  };
  api.addFiles([file]);

  const [element] = convertToExcalidrawElements([
    {
      type: "image",
      fileId,
      x,
      y,
      width,
      height,
      status: "saved",
      customData: {
        name: input.name,
        ...(input.title ? { title: input.title } : {}),
        ...(input.assetId ? { assetId: input.assetId } : {}),
        ...(input.prompt ? { prompt: input.prompt.slice(0, 500) } : {}),
        ...(input.batchId ? { batchId: input.batchId } : {}),
      },
    },
  ]);
  if (!element) throw new Error("图片元素创建失败");

  api.updateScene({
    elements: [...api.getSceneElements(), element],
    captureUpdate: "IMMEDIATELY",
  });
  ensureElementVisible(api, element as unknown as SceneElementLike);
}

export async function insertImageIntoCanvas(
  api: ExcalidrawImperativeAPI,
  input: CanvasImageInput,
): Promise<void> {
  const response = await fetch(input.url);
  if (!response.ok) throw new Error("图片加载失败");

  const blob = await response.blob();
  const dataURL = await blobToDataURL(blob);

  await insertImageData(api, {
    dataURL,
    mimeType: input.mimeType || blob.type || "image/png",
    name: input.name,
    width: input.width,
    height: input.height,
    placement: input.placement,
    batchId: input.batchId,
    assetId: input.assetId,
    title: input.title,
    prompt: input.prompt,
  });
}

export async function insertImageFileIntoCanvas(
  api: ExcalidrawImperativeAPI,
  file: File,
  placement?: CanvasImagePlacement,
): Promise<void> {
  const dataURL = await blobToDataURL(file);
  const size = await loadImageSize(dataURL);

  await insertImageData(api, {
    dataURL,
    mimeType: file.type || "image/png",
    name: file.name || "图片",
    width: size.width,
    height: size.height,
    placement,
  });
}