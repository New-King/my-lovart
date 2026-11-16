/**
 * 生成渠道注册表验收：不调用任何模型服务，只验证模型目录、默认值和路由。
 * 用法：pnpm --filter @my-lovart/server verify:generation-config
 */
import {
  getAvailableImageModels,
  getAvailableVideoModels,
  getGenerationConfig,
  PREFERRED_IMAGE_MODEL,
  resolveDefaultImageModel,
  resolveDefaultVideoModel,
} from "../dist/features/generation/index.js";
import {
  resolveImageModelId,
  resolveImageProviderName,
  resolveVideoModelId,
  resolveVideoProviderName,
} from "../dist/features/generation/providers/registry.js";
import { registerAllProviders } from "../dist/features/generation/providers/register-all.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  registerAllProviders(true);

  const config = getGenerationConfig();
  const imageModels = getAvailableImageModels();
  const videoModels = getAvailableVideoModels();

  check(
    "默认生图模型是 Seedream 4.5",
    config.defaults.imageModel === PREFERRED_IMAGE_MODEL,
    config.defaults.imageModel,
  );
  check(
    "Seedream 4.5 已注册且标记为 semantic 2K/4K",
    imageModels.some(
      (model) =>
        model.id === PREFERRED_IMAGE_MODEL &&
        model.provider === "volces" &&
        model.sizeMode === "semantic",
    ),
    imageModels.map((model) => `${model.provider}:${model.id}`).join(", "),
  );
  check(
    "Seedream 4.5 支持参考图",
    imageModels.find((model) => model.id === PREFERRED_IMAGE_MODEL)?.maxReferenceImages >= 10,
  );
  check(
    "旧 Seedream 5.0 Lite 仍可作为可选模型",
    imageModels.some((model) => model.id === "doubao-seedream-5-0-260128"),
  );
  check(
    "图片模型可以解析到正确渠道",
    resolveImageProviderName(PREFERRED_IMAGE_MODEL) === "volces",
    resolveImageProviderName(PREFERRED_IMAGE_MODEL),
  );
  check(
    "展示名可解析成模型 id",
    resolveImageModelId("Seedream 4.5") === PREFERRED_IMAGE_MODEL &&
      resolveVideoModelId("MiniMax H3") === "MiniMax-H3",
    `${resolveImageModelId("Seedream 4.5")} / ${resolveVideoModelId("MiniMax H3")}`,
  );
  check(
    "视频默认模型来自 VIDEO_MODEL/METASO_VIDEO_MODEL",
    videoModels.some((model) => model.id === resolveDefaultVideoModel()) &&
      resolveVideoProviderName(resolveDefaultVideoModel()) === "metaso",
    resolveDefaultVideoModel(),
  );
  check(
    "视频能力元数据完整（首尾帧/时长上限）",
    videoModels.every(
      (model) =>
        typeof model.capabilities.firstLastFrame === "boolean" &&
        model.limits.maxDuration >= model.limits.minDuration &&
        model.limits.maxInputImages >= 1,
    ),
  );

  let unknownImage = "";
  try {
    resolveImageProviderName("__missing_image_model__");
  } catch (error) {
    unknownImage = error instanceof Error ? error.message : String(error);
  }
  check("未知图片模型被拒绝", /没有图片渠道支持模型/.test(unknownImage), unknownImage || "allowed");

  let unknownVideo = "";
  try {
    resolveVideoProviderName("__missing_video_model__");
  } catch (error) {
    unknownVideo = error instanceof Error ? error.message : String(error);
  }
  check("未知视频模型被拒绝", /没有视频渠道支持模型/.test(unknownVideo), unknownVideo || "allowed");

  check(
    "默认模型解析与配置一致",
    resolveDefaultImageModel() === config.defaults.imageModel &&
      resolveDefaultVideoModel() === config.defaults.videoModel,
  );
} catch (error) {
  results.push({ name: "执行生成渠道验收", ok: false });
  console.error(
    "FAIL 执行生成渠道验收 —",
    error instanceof Error ? error.message : error,
  );
} finally {
  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exitCode = failed === 0 ? 0 : 1;
}