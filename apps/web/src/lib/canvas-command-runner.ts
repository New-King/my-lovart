import type { CanvasCommand } from "@my-lovart/shared";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { arrangeCanvasImages } from "./canvas-image";
import { applyCommandsToScene, type CanvasCommandResult } from "./canvas-commands";

/**
 * 在 Excalidraw 的当前场景上执行服务端下发的画布动作。
 * 纯几何计算在 canvas-commands.ts，这里只负责读写场景。
 */
export function applyCanvasCommands(
  api: ExcalidrawImperativeAPI,
  commands: CanvasCommand[],
): CanvasCommandResult {
  const result = applyCommandsToScene(
    api.getSceneElements() as unknown as Parameters<typeof applyCommandsToScene>[0],
    commands,
  );
  const errors = [...result.errors];

  if (result.applied > 0 && commands.some((command) => command.op !== "arrange")) {
    api.updateScene({
      elements: result.elements as never[],
      captureUpdate: "IMMEDIATELY",
    });
  }

  if (result.arrange) {
    const count = arrangeCanvasImages(api);
    if (count === 0) errors.push("画布上还没有图片可以整理");
  }

  return { applied: result.applied, errors };
}