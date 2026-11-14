import {
  convertToExcalidrawElements,
  getCommonBounds,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
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
};

type ImageDataInput = {
  dataURL: string;
  mimeType: string;
  name: string;
  width?: number;
  height?: number;
  placement?: CanvasImagePlacement;
  batchId?: string;
};

/**
 * 布局全部按当前视口的百分比算，不写死像素：
 * 单图最大占视口宽 18%、高 34%，边距 4%/6%，间距 2%/3%。
 * 换算成场景坐标时再除以 zoom，所以不同缩放下视觉比例一致。
 */
const CELL_WIDTH_RATIO = 0.18;
const CELL_HEIGHT_RATIO = 0.34;
const PAD_X_RATIO = 0.04;
const PAD_Y_RATIO = 0.06;
const GAP_X_RATIO = 0.02;
const GAP_Y_RATIO = 0.03;

type LayoutMetrics = {
  zoom: number;
  originX: number;
  originY: number;
  cellWidth: number;
  cellHeight: number;
  gapX: number;
  gapY: number;
};

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

function fitSize(width: number, height: number, cellWidth: number, cellHeight: number) {
  const scale = Math.min(1, cellWidth / width, cellHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function liveElements(api: ExcalidrawImperativeAPI) {
  return api.getSceneElements().filter((element) => !element.isDeleted);
}

function layoutMetrics(api: ExcalidrawImperativeAPI): LayoutMetrics {
  const appState = api.getAppState();
  const zoom = appState.zoom?.value && appState.zoom.value > 0.05 ? appState.zoom.value : 1;
  const viewportWidth = Math.max(320, appState.width || 0) / zoom;
  const viewportHeight = Math.max(240, appState.height || 0) / zoom;
  const topLeft = viewportCoordsToSceneCoords(
    { clientX: appState.offsetLeft, clientY: appState.offsetTop },
    appState,
  );

  return {
    zoom,
    originX: topLeft.x + viewportWidth * PAD_X_RATIO,
    originY: topLeft.y + viewportHeight * PAD_Y_RATIO,
    cellWidth: viewportWidth * CELL_WIDTH_RATIO,
    cellHeight: viewportHeight * CELL_HEIGHT_RATIO,
    gapX: viewportWidth * GAP_X_RATIO,
    gapY: viewportHeight * GAP_Y_RATIO,
  };
}

/** 新元素完全落在视口外时，缩放到能看到全部内容 */
function ensureElementVisible(api: ExcalidrawImperativeAPI, element: SceneElementLike) {
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
  const visible =
    bottomRight.x > padding &&
    topLeft.x < appState.width - padding &&
    bottomRight.y > padding &&
    topLeft.y < appState.height - padding;

  if (!visible) {
    api.scrollToContent(api.getSceneElements(), { fitToContent: true });
  }
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

  const metrics = layoutMetrics(api);
  const placements = new Map<string, { x: number; y: number }>();

  let rowY = metrics.originY;
  for (const group of groups) {
    let rowX = metrics.originX;
    let rowHeight = 0;
    for (const image of group) {
      // 整理只挪位置，不改变图片本身尺寸
      placements.set(image.id, { x: rowX, y: rowY });
      rowX += image.width + metrics.gapX;
      rowHeight = Math.max(rowHeight, image.height);
    }
    rowY += rowHeight + metrics.gapY;
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

async function insertImageData(
  api: ExcalidrawImperativeAPI,
  input: ImageDataInput,
): Promise<void> {
  const natural =
    input.width && input.height
      ? { width: input.width, height: input.height }
      : await loadImageSize(input.dataURL);

  let x: number;
  let y: number;
  let width: number;
  let height: number;

  if (input.placement) {
    const metrics = layoutMetrics(api);
    ({ width, height } = fitSize(natural.width, natural.height, metrics.cellWidth, metrics.cellHeight));
    x = input.placement.x - width / 2;
    y = input.placement.y - height / 2;
  } else {
    let appState = api.getAppState();
    for (let index = 0; index < 20 && (appState.width === 0 || appState.height === 0); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      appState = api.getAppState();
    }

    const metrics = layoutMetrics(api);
    ({ width, height } = fitSize(natural.width, natural.height, metrics.cellWidth, metrics.cellHeight));

    const rows = rowsFor(api);
    let row = input.batchId ? rows.get(input.batchId) : undefined;

    if (row) {
      // 同批次继续往右排，顶部对齐
      x = row.cursorX;
      y = row.y;
    } else {
      const scene = liveElements(api);
      if (scene.length === 0) {
        // 空白画布 → 左上角起排，不居中也不铺满
        x = metrics.originX;
        y = metrics.originY;
      } else {
        // 已有内容 → 新批次另起一行，放在内容下方
        const [left, , , bottom] = getCommonBounds(scene);
        x = Number.isFinite(left) ? left : metrics.originX;
        y = (Number.isFinite(bottom) ? bottom : metrics.originY) + metrics.gapY;
      }

      if (input.batchId) {
        row = { cursorX: x, y };
        rows.set(input.batchId, row);
      }
    }

    if (row) row.cursorX = x + width + metrics.gapX;
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