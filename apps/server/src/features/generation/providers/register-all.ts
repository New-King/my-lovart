import { env } from "../../../lib/env.js";
import { metasoVideoProvider } from "../metaso-video.js";
import { volcesImageProvider } from "../volces-image.js";
import {
  clearProviders,
  registerImageProvider,
  registerVideoProvider,
} from "./registry.js";

let registered = false;

/**
 * 条件注册：没有 key 的渠道不出现，避免列表里选到必然失败的模型。
 * 新增 provider 时只在这里加一行，业务层不需要知道具体厂商。
 */
export function registerAllProviders(force = false): void {
  if (registered && !force) return;
  clearProviders();

  if (env.arkApiKey) registerImageProvider(volcesImageProvider);
  if (env.metasoApiKey) registerVideoProvider(metasoVideoProvider);

  registered = true;
}