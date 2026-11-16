# 生成渠道与模型配置

> 状态：已实现（注册表 + 环境变量默认模型 + 只读模型目录）
> 最后更新：2026-11-16
> 关联：`docs/notes/M28.md`

## 为什么不是“每个模型一份代码”

照片/视频供应商的 API 字段不同，但业务层只关心：

- 输入：prompt、画幅、参考图、时长、分辨率、取消信号、进度回调；
- 输出：URL、mime、宽高、时长、实际模型名。

因此采用 **一个厂商一个 adapter + 统一注册表**，而不是每个模型复制业务工具。新增模型只需要在 adapter 的 `models` 元数据里加一行；新增厂商只需实现 `ImageProvider` / `VideoProvider` 并在 `register-all.ts` 按 key 注册。这与 Lavart 的 `providers/registry.ts` + provider class 模式一致，但我们的输入/输出契约更窄，不包含计费、积分、品牌套件。

## 目录

```
apps/server/src/features/generation/
  index.ts                 # 业务唯一入口：generateImage / generateVideo / getGenerationConfig
  types.ts                 # ImageProvider / VideoProvider / 模型元数据 / GenerationError
  providers/
    registry.ts            # 注册、按模型找渠道、展示名解析、模型目录
    register-all.ts        # 按 ARK_API_KEY / METASO_API_KEY 条件注册
  volces-image.ts          # 火山方舟 Seedream adapter
  metaso-video.ts          # Metaso / MiniMax adapter
  video-frame.ts           # ffmpeg 抽末帧（不是 provider）
```

worker、Agent 工具只能 import `generation/index.js`，不得直接 import `volces-image.ts` 或 `metaso-video.ts`。

## 模型元数据

图片模型包含：`id`、`displayName`、`description`、`supportsReferenceImages`、`maxReferenceImages`、`sizeMode`（semantic/pixel）、`qualities`。

视频模型包含：`capabilities`（textToVideo/imageToVideo/firstLastFrame/referenceImages）、`limits`（min/max 时长、最大参考图、最大分辨率）、`defaultDurationSeconds`。

`GET /generation/models` 返回当前默认值和全部已注册模型，不返回任何 key；后续要做后台模型选择器时直接复用。

## 默认值与环境变量

```env
IMAGE_PROVIDER=                 # 可选；同一模型多渠道时指定
IMAGE_MODEL=doubao-seedream-4-5-251128
IMAGE_QUALITY=hd                # standard / hd / ultra
ARK_IMAGE_WATERMARK=false
ARK_API_KEY=...                 # 优先；VOLCES_API_KEY 兼容
ARK_API_BASE=https://ark.cn-beijing.volces.com/api/v3

VIDEO_PROVIDER=                 # 可选
VIDEO_MODEL=MiniMax-H3
VIDEO_RESOLUTION=720p           # 480p / 720p / 1080p
METASO_API_KEY=...
METASO_API_BASE=https://metaso.cn/api/minimax/
```

默认值解析顺序：

1. 显式工具参数 `model` / `quality` / `resolution`；
2. 环境变量 `IMAGE_MODEL` / `VIDEO_MODEL`；
3. 图片优先 `doubao-seedream-4-5-251128`，然后第一个已注册模型；
4. 视频第一个已注册模型。

工具参数只在用户明确指定模型/分辨率时传。Agent 不应自行切换模型。

## 模型支持细节

### Seedream 4.5

- 模型 id：`doubao-seedream-4-5-251128`；
- `size` 方式 1：只支持 `2K` / `4K`；prompt 必须说明画幅，否则模型可能输出默认 4:3；
- 方式 2：显式 WxH，总像素 3,686,400–16,777,216，宽高比 1/16–16；
- 参考图最多 14 张，我们业务限制 10 张；
- 当前 adapter 使用方式 1（`2K`/`4K`）并在 prompt 追加 `画面比例：X，严格按 X 构图`；
- `standard` 档会映射到 `2K`（4.5 没有 1K）。

### Seedream 5.0 Lite / 4.0

- 保持显式 WxH（method 2），尺寸映射在 `PIXEL_SIZES`；
- 仍可作为 `IMAGE_MODEL` 切回。

### MiniMax / Metaso

- H3、Highspeed、Lite：4–15 秒；Max：5–15 秒；
- 首帧/尾帧图生视频与多模态参考模式互斥；adapter 只发前两张图作为 first_frame / last_frame；
- `720p` 映射为 provider 的 `768P`，`1080p` 映射 `1080P`，`480p` 映射 `512P`。

## 验收

- `pnpm --filter @my-lovart/server verify:generation-config`
  - 默认图片模型是 Seedream 4.5；
  - 4.5 标记 semantic、支持 2K/4K、支持参考图；
  - 旧 5.0 Lite 仍可选；
  - 展示名可解析为 id；
  - 未知图片/视频模型被拒绝；
  - 默认值解析一致。
- `pnpm --filter @my-lovart/server verify:video-guard` 确保生成入口改动没有破坏前期闸门。

## 还没做

- 按项目/用户/客户的后台模型配置表（当前是进程级环境变量 + 单次工具参数）；
- 模型额度/价格/可用性探测；
- 多渠道路由的自动降级（例如图片渠道 429 时切备用渠道）。