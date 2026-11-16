# 灵感搜索（Pexels）

> 状态：工具与 UI 已接，真实 Pexels 搜索待配置 `PEXELS_API_KEY`
> 最后更新：2026-11-16
> 关联：`docs/notes/M32.md`、`apps/server/src/features/inspiration/pexels.ts`

## 为什么做

Video_Remix_Benlai 的 `search_references` 启发了我们：当用户没有明确风格方向时，先给一组公开视觉参考，让用户选方向，比让 Agent 凭空猜“日系/暗调/高级感”更可靠。

但它是通用“灵感/参考/调性/版式/竞品”原子动作，不应写死成“视频前必须搜图”。我们的原则：

- 用户没有明确方向、或主动说“找灵感/参考/竞品/看看别人怎么做”时才搜；
- 用户已有产品实拍/参考图/logo，或者只是改一张已有图时跳过；
- 搜完本轮只展示方向、让用户选，不在同轮自动生成设定图/分镜/视频；
- 搜到的公开图只是方向参考，不是可执行产品锚图，不能保证客户产品一致性。

## 工具

`search_inspiration`：

```json
{
  "title": "通勤方向参考",
  "directions": [
    { "label": "日系留白", "query": "japanese minimal still life morning light" },
    { "label": "暗调产品", "query": "dark moody product photography" }
  ],
  "orientation": "portrait",
  "color": "warm",
  "perPage": 4
}
```

- 1-3 个方向，每个方向 4-6 张；
- `label` 是给用户看的中文方向名，`query` 是 Pexels 英文检索词；
- 视频 9:16 用 `orientation: "portrait"`，横屏用 `landscape`；
- 返回多个 `InspirationBlock`，前端已有卡片可预览、拖拽、点击“加入对话”。

## UI 选择

灵感卡片下提示：

> 点缩略图右上角箭头加入对话，选一张作为方向；也可以回复“第 2 组第 1 张”。

用户选中后，图片成为下一轮 `<input_images>` 的引用，Agent 再把它作为 `inputImages` 做产品设定图/关键帧。这样“选方向”不是隐式状态，而是可回放的消息附件。

## API 与错误

`GET https://api.pexels.com/v1/search`，`Authorization: <PEXELS_API_KEY>`，参数：`query`、`orientation`、`color`、`per_page`、`page`。

- 缺 key → `invalid_config`；
- 401/403 → `invalid_config`；
- 429/5xx → 可重试 `provider_error`；
- 网络失败 → `network_error`；
- 空关键词 → `invalid_search`。

## 验收

`pnpm --filter @my-lovart/server verify:inspiration` 用假 fetch 验证，不消耗真实额度，9/9：

- 映射为统一 `InspirationItem`；
- 优先 `large2x` 主图；
- 保留摄影师/sourceUrl；
- 请求路径、orientation、per_page 正确；
- Authorization 使用 `PEXELS_API_KEY`（测试不打印值）；
- 工具返回 2 组 inspiration block；
- summary 要求“让用户看图选方向”；
- 401 映射 `invalid_config`；
- 空关键词被拒绝。

## 还没做

- 真实 Pexels 搜索：`Video_Remix_Benlai` 里只有 `config/config.example.yml` 的占位符，实际 `config/config.yml` 是 gitignore 且不在当前挂载目录；需要把 Pexels API Key 放进 my-lovart 的 `.env.local` 的 `PEXELS_API_KEY`；
- 用户回复“第 2 组第 1 张”时，Agent 目前要靠上下文和卡片顺序定位；还没做图片索引的显式选择状态；
- 把选中的灵感图作为“风格参考”传给 Seedream 时，需要用户把它加入对话成为附件；不能直接把 `sourceUrl` 当产品锚图血缘；
- 搜图结果没有缓存/频率限制；真实接入后按 Pexels 配额加一次搜索锁和缓存。