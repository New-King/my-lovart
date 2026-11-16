# 视频前期：锚图组、关键帧、镜头时长与连贯性

> 状态：Phase 3a/3b/3c/3d 已实现（多镜头拼接未实现）
> 最后更新：2026-11-16
> 关联：`docs/notes/M23.md`、`docs/notes/M24.md`、`docs/notes/M25.md`、`docs/notes/M27.md`、`docs/specs/project-state-and-storyboard.md`

## 问题

用户要保温杯视频，模型直接建了 4 个镜头、分别文生图。4 张图里杯子形状/材质各不相同，看起来像 4 个不同产品。trace 显示每次 `generate_image` 只有 prompt 和 shotId，没有 `inputImages`，也没有共享参考；分镜的 `active_asset_id` 还把图片和视频混在同一个指针里。

这不是“图片模型不稳定”，而是前期缺了三层：

1. 没有产品/角色/场景/主视觉锚图，每个镜头各自从文字重新发明产品；
2. 没有区分“执行锚图 / 分镜首尾帧 / 成片片段”，4 张图既不是连贯分镜，也不是视频输入；
3. 没有时长预算：5 秒拆 4 段，每段 1-2 秒，低于视频 provider 单段最短 4 秒，根本不能逐段出片。

## 外部参考审计

**Lavart 仓库**没有这套前期模型：`video-generate.ts` 的 `inputImages` 最多 7 张，第一张作为首帧；前端提供首帧/尾帧上传；prompt 只有“视频 → generate_video”。没有 canon、storyboard、镜头时长或确认闸门，照抄解决不了产品一致性。

**Video_Remix_Benlai** 的 `无限画布-生成视频对话参考.txt` 展示了正确的工作方式：以分镜图作为首帧逐镜生成、4 秒为最小单位、镜头逐条确认；但真正有价值的是它的制作级规格文档：

- 4 层产物：粗分镜 → 角色/场景/产品/主视觉锚图组（3-5 张）→ 细分镜 + prompt 包 → 执行前放行；
- 一致性拆成三层：静态一致性（角色/产品/场景/色温）、镜头内一致性、段落连贯性；
- 每镜必须有 `continuity_note`、`reference_bindings`、`must_have_elements`、`negative_elements`、`start_state/end_state`；
- 下一段显式承接上一段最后一帧；上一镜末帧可能作为下一镜输入；
- 锚图按 brief 动态规划，不固定每次都生成角色图；没有人物就不强加角色锚。

它自己承认这套“锚图映射”是工程假设，不是参考网站已证实的公开规则；我们取它的结构和连贯性方法，不照搬固定模板。

## 三层产物

| 层 | 角色 | 数量 | 是否进视频 | 生成方式 |
| --- | --- | --- | --- | --- |
| 锚图组 | `canon` + `anchorType=product/product_detail/character/scene/style` | 产品锚 1 张必需；开盖/内胆等状态另需 product_detail；其余按需 | 否，只做参考 | 产品锚/细节锚必须基于用户实拍图；其余可文生图；确认后锁定 |
| 分镜首尾帧 | `keyframe` / `end_frame` | 每镜 1 张首帧；多镜头除收尾外必须有尾帧 | 首帧作为视频第一帧，尾帧作为最后一帧 | 自动引用锚图组 + 上一镜尾帧（首帧）或当前首帧（尾帧） |
| 成片片段 | `video` | 每镜 1 条 | 最终交付 | `generate_video(shotId)`，首尾帧和时长由镜头锁定 |

`planImageReferences` 在生成关键帧时默认带：当前已确认首帧 → 产品锚 → 细节锚 → 主视觉/衔接帧（最多 4 张）；scene/character 不再默认稀释产品主体。开盖/螺纹/内胆/倒水等状态没有 `product_detail` 锚图会直接返回 `product_state_reference_required`。生成结果记录 `metadata.role` 与 `sourceAssetIds`；出片预检校验首帧产品锚血缘和上一镜实际末帧。

## 连贯性方案

静态一致性靠锚图组；段落连贯靠“实际视频末帧”：

1. 镜头 1 首帧基于产品锚 + 主视觉锚生成；
2. 镜头 1 尾帧基于锚图 + 镜头 1 首帧生成；
3. 镜头 1 出片后用 ffmpeg 抽取实际最后一帧，登记 `video_last_frame_asset_id`；
4. 镜头 2 首帧只承接这个实际末帧（不是再次生成的尾帧图），再生成镜头 2 尾帧；
5. 镜头 2 出片、抽末帧，继续下一镜；
6. 非收尾镜头没有尾帧 → `end_frame_required`；上一镜没视频 → `previous_video_required`；首帧没承接实际末帧 → `continuity_not_anchored`。

MiniMax H3 支持首帧/尾帧图生视频，单段 4-15 秒。图生视频与多模态参考互斥，所以产品信息必须提前固化到首尾帧。抽帧失败时降级到 `end_frame`，不失败整个 job。

## 时长与镜头数

- 5 秒 → 1 个镜头（1 张首帧，可选尾帧），不是 4 张；
- 10 秒 → 最多 2 个镜头（建议 5+5）；
- 15 秒 → 最多 3 个镜头（建议 5+5+5）；
- 规则：每镜头 4-15 秒，合计等于总时长，镜头数 ≤ `floor(总时长 / 4)`。

`create_storyboard(kind="video")` 会校验；5 秒拆 4 段直接报错。纯视觉分镜用 `kind="image"`，没有时长约束。

## 数据模型

migration `0010` / `0011` / `0012`（已执行）：

- `storyboards.kind`、`canon_asset_id`（产品锚）、`character_anchor_asset_id`、`scene_anchor_asset_id`、`style_anchor_asset_id`、`total_duration_seconds`
- `storyboard_shots.first_frame_asset_id` / `end_frame_asset_id` / `video_asset_id` / `video_last_frame_asset_id`
- `storyboard_shots.scene_goal` / `continuity_note` / `negative_prompt`

旧 `active_asset_id` 只保留兼容；新代码按角色写独立指针。

## 流程

1. 需求：平台/画幅、总时长、基调；产品锚必须要求用户上传正面/侧面/背面/俯视实拍图。
2. 脚本：按镜头列画面、运镜、节奏、sceneGoal、continuityNote、negativePrompt。
3. `create_storyboard({kind:"video", totalDurationSeconds, shots})`：只写文字时间线。
4. 生成锚图组：`generate_image({role:"canon", anchorType:"product", storyboardId, inputImages:[产品图]})`；开盖/内胆/螺纹再加 `anchorType:"product_detail"`。本轮给用户确认，不能同轮出关键帧（`canon_unconfirmed`）。
5. 下一轮按镜序闭环：镜头 1 keyframe + end_frame → 用户确认 → `generate_video(shot1)` → 服务端抽实际末帧。
6. 镜头 2 keyframe 承接镜头 1 实际末帧 → end_frame → 确认 → 出片 → 抽末帧，依此类推。
7. 多镜头全部完成后，才进入拼接成片。

## 仍未实现

**多段视频拼接**。当前 `generate_video` 一条只生成一个镜头的 clip；10 秒 2 个镜头会得到 2 条 5 秒视频，还不会自动合成一条 10 秒成片。拼接需要 ffmpeg 或供应商合成能力，是下一步，不能在 UI/文案里假装已经完成。

**按镜头绑定锚图**。当前锚图组对整个分镜生效；单场景产品片足够，多场景/多角色长片后续要支持“这一镜只引用场景 A + 产品锚”。这是已知粒度限制。

## 验收

`apps/server/scripts/verify-video-guard.mjs`，24/24 通过，不调用图片/视频 provider；`verify-video-frame.mjs` 通过（生成 1 秒测试视频并抽末帧）：

- 无产品实拍 → `canon_photo_required`；无细节实拍 → `detail_photo_required`
- 无 shotId → `video_plan_required`
- 5 秒拆 4 镜头 / 概念板直接转视频 → 校验拒绝
- 本轮新建镜头 → `video_plan_unconfirmed`
- 本轮新锚图未确认 → `canon_unconfirmed`
- 开盖/内部状态缺细节锚图 → `product_state_reference_required`
- 缺 canon → 关键帧/出片均 `canon_required`
- 关键帧自动以 canon 为第一参考图
- 缺首帧 → `keyframe_required`
- 首帧没有 canon 血缘 → `keyframe_not_anchored`
- 已确认 canon + 首帧 → 放行
- 首帧本轮新出 → `keyframe_unconfirmed`
- 多镜头首镜缺尾帧 → `end_frame_required`
- 上一镜没视频 → `previous_video_required`
- 下一镜自动承接上一镜实际末帧
- 没承接实际末帧的首帧 → `continuity_not_anchored`
- 两镜末帧接通 → 放行
- 重做同一镜首帧 → 当前已确认首帧是第一参考
- `direct=true` 显式跳过