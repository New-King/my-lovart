import { convertToExcalidrawElements, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
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
};

type ImageDataInput = {
  dataURL: string;
  mimeType: string;
  name: string;
  width?: number;
  height?: number;
  placement?: CanvasImagePlacement;
};

const MAX_WIDTH = 560;
let offsetSeed = 0;

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

  const scale = Math.min(1, MAX_WIDTH / natural.width);
  const width = Math.max(1, Math.round(natural.width * scale));
  const height = Math.max(1, Math.round(natural.height * scale));

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
    const center = viewportCoordsToSceneCoords(
      {
        clientX: appState.offsetLeft + appState.width / 2,
        clientY: appState.offsetTop + appState.height / 2,
      },
      appState,
    );
    const offset = (offsetSeed++ % 5) * 24;
    x = center.x - width / 2 + offset;
    y = center.y - height / 2 + offset;
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
      customData: { name: input.name },
    },
  ]);
  if (!element) throw new Error("图片元素创建失败");

  api.updateScene({ elements: [...api.getSceneElements(), element] });
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