import type { CanvasCommand } from "@my-lovart/shared";

export type CanvasCommandResult = {
  /** 实际执行了多少个动作 */
  applied: number;
  errors: string[];
};

type SceneElementLike = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  isDeleted?: boolean;
  version: number;
  versionNonce: number;
  updated: number;
};

export type CanvasSceneResult = CanvasCommandResult & {
  elements: SceneElementLike[];
  /** 需要交给 Excalidraw 的 arrangeCanvasImages 统一整理 */
  arrange: boolean;
};

function touch(
  element: SceneElementLike,
  patch: Partial<SceneElementLike>,
): SceneElementLike {
  return {
    ...element,
    ...patch,
    version: (element.version ?? 0) + 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    updated: Date.now(),
  };
}

function liveTargets(scene: SceneElementLike[], ids: string[]) {
  const wanted = new Set(ids);
  return scene.filter((element) => !element.isDeleted && wanted.has(element.id));
}

function boundsOf(elements: SceneElementLike[]) {
  const minX = Math.min(...elements.map((element) => element.x));
  const minY = Math.min(...elements.map((element) => element.y));
  const maxX = Math.max(...elements.map((element) => element.x + element.width));
  const maxY = Math.max(...elements.map((element) => element.y + element.height));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * 纯函数：在给定元素数组上执行画布动作，不依赖 Excalidraw API。
 * 只改位置 / 尺寸 / 顺序，不碰图片文件。
 */
export function applyCommandsToScene(
  input: readonly SceneElementLike[],
  commands: CanvasCommand[],
): CanvasSceneResult {
  let scene = [...input];
  let applied = 0;
  const errors: string[] = [];
  let arrange = false;

  for (const command of commands) {
    if (command.op === "arrange") {
      arrange = true;
      applied += 1;
      continue;
    }

    const targets = liveTargets(scene, command.ids);
    if (targets.length === 0) {
      errors.push(`没有找到要操作的元素（${command.ids.join(", ")}）`);
      continue;
    }
    const targetIds = new Set(targets.map((element) => element.id));

    switch (command.op) {
      case "move": {
        const bounds = boundsOf(targets);
        const dx = command.x !== undefined ? command.x - bounds.minX : (command.dx ?? 0);
        const dy = command.y !== undefined ? command.y - bounds.minY : (command.dy ?? 0);
        if (dx !== 0 || dy !== 0) {
          scene = scene.map((element) =>
            targetIds.has(element.id)
              ? touch(element, { x: element.x + dx, y: element.y + dy })
              : element,
          );
        }
        applied += 1;
        break;
      }

      case "resize": {
        scene = scene.map((element) => {
          if (!targetIds.has(element.id)) return element;
          if (command.scale !== undefined) {
            return touch(element, {
              width: Math.max(1, element.width * command.scale),
              height: Math.max(1, element.height * command.scale),
            });
          }
          return touch(element, {
            width: Math.max(1, command.width ?? element.width),
            height: Math.max(1, command.height ?? element.height),
          });
        });
        applied += 1;
        break;
      }

      case "delete": {
        scene = scene.filter((element) => !targetIds.has(element.id));
        applied += 1;
        break;
      }

      case "align": {
        const bounds = boundsOf(targets);
        scene = scene.map((element) => {
          if (!targetIds.has(element.id)) return element;
          switch (command.edge) {
            case "left":
              return touch(element, { x: bounds.minX });
            case "right":
              return touch(element, { x: bounds.maxX - element.width });
            case "top":
              return touch(element, { y: bounds.minY });
            case "bottom":
              return touch(element, { y: bounds.maxY - element.height });
            case "centerX":
              return touch(element, { x: bounds.minX + (bounds.width - element.width) / 2 });
            case "centerY":
              return touch(element, { y: bounds.minY + (bounds.height - element.height) / 2 });
            default:
              return element;
          }
        });
        applied += 1;
        break;
      }

      case "distribute": {
        const sorted = [...targets].sort((a, b) =>
          command.axis === "horizontal" ? a.x - b.x : a.y - b.y,
        );
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        if (!first || !last) break;

        const horizontal = command.axis === "horizontal";
        const span = horizontal
          ? last.x + last.width - first.x
          : last.y + last.height - first.y;
        const used = sorted.reduce(
          (sum, element) => sum + (horizontal ? element.width : element.height),
          0,
        );
        const gap = (span - used) / Math.max(1, sorted.length - 1);
        let cursor = horizontal ? first.x : first.y;
        const placements = new Map<string, number>();

        for (const element of sorted) {
          placements.set(element.id, cursor);
          cursor += (horizontal ? element.width : element.height) + gap;
        }

        scene = scene.map((element) => {
          const next = placements.get(element.id);
          if (next === undefined) return element;
          return touch(element, horizontal ? { x: next } : { y: next });
        });
        applied += 1;
        break;
      }

      case "reorder": {
        const moving = scene.filter((element) => targetIds.has(element.id));
        const rest = scene.filter((element) => !targetIds.has(element.id));
        scene = command.to === "front" ? [...rest, ...moving] : [...moving, ...rest];
        applied += 1;
        break;
      }

      case "opacity": {
        const opacity = Math.min(100, Math.max(0, command.opacity));
        scene = scene.map((element) =>
          targetIds.has(element.id) ? touch(element, { opacity }) : element,
        );
        applied += 1;
        break;
      }
    }
  }

  return { elements: scene, applied, errors, arrange };
}