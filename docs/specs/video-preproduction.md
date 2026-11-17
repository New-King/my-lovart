# 视频前期：先选路径，再做锚图/关键帧/连贯性

> 状态：Phase 3a/3b/3c/3d/3e 已实现（多镜头拼接未实现）；2026-11-17 修正为条件流程
> 最后更新：2026-11-17
> 关联：`docs/notes/M23.md`、`M24`、`M25`、`M27`、`M29`、`M34`、`docs/specs/project-state-and-storyboard.md`

## 问题

用户要保温杯视频，模型直接建了 4 个镜头、分别文生图。4 张图里杯子形状/材质各不相同，看起来像 4 个不同产品。trace 显示每次 `generate_image` 只有 prompt 和 shotId，没有 `inputImages`，也没有共享参考；分镜的 `active_asset_id` 还把图片和视频混在同一个指针里。

这不是“图片模型不稳定”，而是前期缺了三层：

1. 没有产品/角色/场景/主视觉锚图，每个镜头各自从文字重新发明产品；
2. 没有区分“执行锚图 / 分镜首尾帧 / 成片片段”，4 张图既不是连贯分镜，也不是视频输入；
3. 没有时长预算：5 秒拆 4 段，每段 1-2 秒，低于视频 provider 单段最短 4 秒，根本不能逐段出片。

## 外部参考审计

**Lavart 仓库**没有这套多镜头前期模型：`video-generate.ts` 的 `inputImages` 最多 7 张，第一张作为首帧；前端提供首帧/尾帧上传；prompt 只有“视频 → generate_video”。它的优点正是单条 image-to-video 很直接；缺点是多镜头没有 canon/continuity。我们两条都要：单条走 A 路径，多镜头才进入锚图/分镜。

**Video_Remix_Benlai** 的 `无限画布-生成视频对话参考.txt` 展示了正确的工作方式：以分镜图作为首帧逐镜生成、4 秒为最小单位、镜头逐条确认；但真正有价值的是它的制作级规格文档：

- 4 层产物：粗分镜 → 角色/场景/产品/主视觉锚图组（3-5 张）→ 细分镜 + prompt 包 → 执行前放行；
- 一致性拆成三层：静态一致性（角色/产品/场景/色温）、镜头内一致性、段落连贯性；
- 每镜必须有 `continuity_note`、`reference_bindings`、`must_have_elements`、`negative_elements`、`start_state/end_state`；
- 下一段显式承接上一段最后一帧；上一镜末帧可能作为下一镜输入；
- 锚图按 brief 动态规划，不固定每次都生成角色图；没有人物就不强加角色锚。

它自己承认这套“锚图映射”是工程假设，不是参考网站已证实的公开规则；我们取它的结构和连贯性方法，不照搬固定模板。

## 先选路径（条件流程，不是固定流水线）

视频没有一条统一流水线。先看用户已有的素材和交付形态：

| 场景 | 做法 | 不做什么 |
| --- | --- | --- |
| A 单镜头/单动作 + 已有主体图 | `generate_video({ inputImages:[那张图], durationSeconds, prompt, direct:true })`，直接 image-to-video | 不生成角色/产品设定图，不出首尾帧，不建分镜 |
| B 多镜头 + 已有主体参考图 | 建 `kind=video` 分镜，`referenceDirect=true`；`register_reference(assetId, storyboardId, anchorType)` 把用户图登记为 canon；每镜 `generate_video(shotId, inputImages:[参考图])`；第一镜用参考图，后续镜服务端自动用上一镜实际末帧作首帧 | 默认不生成关键帧，更不生成角色设定图；只有角度差异极大/需要精确构图时才 `referenceDirect=false` 走 keyframe |
| C 多镜头 + 没有参考图 | 按 consistency 生成一次 canon（产品/角色/场景按 brief），确认后逐镜 keyframe | 不固定生成四张锚图 |
| D 纯文字单镜头、没有图 | 建 1 镜分镜 + 首帧给用户确认；用户原话允许时可以 direct | 不假装已有参考图 |
| E 用户要脚本/分镜/概念探索 | 先文字/分镜，不急着出图/出片 | 不把“要视频”当成“确认了画面” |

`direct=true` 的许可由服务端判定（`checkDirectVideoInput`）：有主体图做单条 image-to-video，或用户原话明确“直接出片/不用确认”；两者都没有时拒绝，避免模型偷懒跳过整个前期。

`referenceDirect=true` 是分镜级开关：preflight 跳过 `keyframe_required` / `keyframe_not_anchored` / `end_frame_required`，但仍要求 canon 和上一镜视频；出片时服务端自动选参考图——第一镜用 canon 用户图，后续镜用上一镜 `video_last_frame_asset_id`，保证身份和剪辑点，不额外生成关键帧。

## 动作主体与首帧一致性

图生视频只能从**首帧里已经存在的主体和姿态**往下动，不能指望模型补出一个执行动作的人。

- 压弯、骑行、摇车、踩踏、起身、奔跑、挥手等动作，必须由首帧里的骑手/人物执行；无人物产品设定图只锁车型/配色/材质，不能直接当动作镜头首帧。
- `generate_image(role=keyframe)` 的 prompt 出现这些动作但没有写骑手/人物时，返回 `action_actor_required`，要求先补“骑手压低身体压弯”这类动作首帧。
- 视频 prompt 也做同样检查，且 `direct=true` 不能绕过；`referenceDirect=true` 或用户上传图例外（图里可能本来就有主体）。
- 视频 prompt 必须以首帧的可见状态为起点：首帧主车在近景就写“画面近景的主车开始…”，不要写“从画面深处驶来”，否则模型会去动背景里的第二个骑手。
- 纯产品运镜（环绕、推近、光影扫过、轮组转动）不需要人物，不受这条限制。

失败样本（2026-11-17）：公路车广告第 1 镜首帧是“前景静止整车 + 远处一个骑手”，视频 prompt 写“公路车从画面深处高速压弯逼近”。图生视频把远处骑手动了起来，前景产品车不动，成片变成“路人骑过一辆停着的车”。修复不是改一句文案，而是首帧必须包含骑手和压弯姿态，且视频 prompt 只能描述这个首帧主体的运动。

## 画幅锁定

`create_storyboard(kind=video)` 必须传 `aspectRatio`；没有就返回 `aspect_ratio_required`。`generate_image` 生成 canon / keyframe / end_frame 时优先使用分镜的 `aspectRatio`，不再让模型随手传的默认 3:4 覆盖 16:9 或 9:16 的片子。当前 run 里已经生成过的旧 3:4 canon 不会被追溯修改；重做时按新规则生成。

用户提供的图可以**直接**成为 canon（`origin=uploaded`），不需要重新生成一版设定图。产品用 `anchorType=product`，角色用 `character`；角色锚在没有产品 canon 时会同时写入 `canon_asset_id`，否则角色视频会被 `canon_required` 卡死。

## 三层产物

| 层 | 角色 | 数量 | 是否进视频 | 生成方式 |
| --- | --- | --- | --- | --- |
| 锚图组 | `canon` + `anchorType=product/product_detail/character/scene/style` | 产品锚 1 张；开盖/内胆等状态另需 product_detail；其余按需 | 否，只做参考 | strict：产品锚/细节锚必须真实实拍；adaptive：有实拍用实拍，没有可生成并标注；loose：可直接生成；确认后锁定 |
| 分镜首尾帧 | `keyframe` / `end_frame` | 每镜 1 张首帧；多镜头除收尾外必须有尾帧 | 首帧作为视频第一帧，尾帧作为最后一帧 | 自动引用锚图组 + 上一镜尾帧（首帧）或当前首帧（尾帧） |
| 成片片段 | `video` | 每镜 1 条 | 最终交付 | `generate_video(shotId)`，首尾帧和时长由镜头锁定 |

## 一致性策略（per-storyboard）

一致性不是全局写死的一套流程，而是每个分镜自己的 `metadata.consistency`：

- `strict`：客户有产品实拍，或明确要求“不能变形/必须还原真实产品”。产品锚、细节锚必须有真实参考；多镜头必须按实际末帧衔接；缺环就拒绝。
- `adaptive`（默认）：有实拍就用实拍；没有实拍允许生成产品设定图并返回 `warning` 说明“这是生成图，不是客户真实产品”。开盖/内部状态仍需先有细节锚图，但细节锚可以基于产品设定图生成草案；多镜头按末帧衔接。
- `loose`：快速概念/草稿。允许无 canon/首帧直接出片，不强制多镜头末帧衔接；仍保留 `video_plan_unconfirmed`，脚本必须先给用户看到。输出会有风险提示。

`create_storyboard` / `update_storyboard` 传 `consistency`；旧分镜默认 adaptive，不需要新 migration。`<project_state>` 会带 `consistency`，Agent 按当前档位决定是否补素材。

`planImageReferences` 在生成关键帧时默认带：当前已确认首帧 → 产品锚 → 细节锚 → 主视觉/衔接帧（最多 4 张）；scene/character 不再默认稀释产品主体。strict/adaptive 下开盖/螺纹/内胆/倒水等状态没有 `product_detail` 锚图会返回 `product_state_reference_required`，loose 可跳过。生成结果记录 `metadata.role` 与 `sourceAssetIds`；出片预检校验首帧产品锚血缘和上一镜实际末帧。

## 连贯性方案

静态一致性靠锚图组；段落连贯靠“实际视频末帧”：

1. 用户确认锚图后，下一轮一次性生成**所有镜头**的首帧 + 尾帧；镜头 2 首帧用镜头 1 尾帧做预览衔接，不要求先有视频。
2. 全部帧和完整脚本方案一起给用户确认；这是默认的第二个、也是最后一个前期停点。
3. 用户确认后按镜序连续出片：镜头 1 出片 → ffmpeg 抽实际末帧；
4. 镜头 2 视频的起始帧优先用镜头 1 **实际末帧**（预生成首帧只作预览），尾帧仍用镜头 2 的 end_frame；
5. 镜头 2 出片、抽末帧，继续下一镜，不再逐镜确认。
6. 非收尾镜头没有尾帧 → `end_frame_required`；上一镜没视频 → `previous_video_required`。`continuity_not_anchored` 已取消：连续性由出片时的实际末帧保证。

默认停点只有两个：需要生成锚图时的“锚图确认”，以及“全部分镜图 + 脚本方案”确认。单条 image-to-video 没有这些停点。

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

1. 需求：平台/画幅、总时长、基调；根据客户是否提供产品实拍、是否要求还原选择 consistency。strict 需要正面/侧面/背面/俯视实拍；adaptive 没有实拍也能先生成设定图；loose 直接出草稿。
2. 脚本：按镜头列画面、运镜、节奏、sceneGoal、continuityNote、negativePrompt。
3. `create_storyboard({kind:"video", totalDurationSeconds, consistency, shots})`：只写文字时间线。
4. 生成锚图组：`generate_image({role:"canon", anchorType:"product", storyboardId, inputImages:[产品图]})`；有实拍就传，没有实拍按策略生成并标注。开盖/内胆/螺纹再加 `anchorType:"product_detail"`。strict/adaptive 本轮给用户确认，不能同轮出关键帧（`canon_unconfirmed`）。
5. 下一轮按镜序闭环：镜头 1 keyframe + end_frame → 用户确认 → `generate_video(shot1)` → 服务端抽实际末帧。
6. 镜头 2 keyframe 承接镜头 1 实际末帧 → end_frame → 确认 → 出片 → 抽末帧，依此类推。
7. 多镜头全部完成后，才进入拼接成片。

## 仍未实现

**多段视频拼接**。当前 `generate_video` 一条只生成一个镜头的 clip；10 秒 2 个镜头会得到 2 条 5 秒视频，还不会自动合成一条 10 秒成片。拼接需要 ffmpeg 或供应商合成能力，是下一步，不能在 UI/文案里假装已经完成。

**按镜头绑定锚图**。当前锚图组对整个分镜生效；单场景产品片足够，多场景/多角色长片后续要支持“这一镜只引用场景 A + 产品锚”。这是已知粒度限制。

## 验收

`apps/server/scripts/verify-video-guard.mjs`，30/30 通过，不调用图片/视频 provider；`verify-video-frame.mjs` 通过（生成 1 秒测试视频并抽末帧）：

- strict 无产品实拍 → `canon_photo_required`；strict 无细节实拍 → `detail_photo_required`
- adaptive 无产品实拍 → 允许生成设定图并返回 warning；adaptive 无细节实拍 → 允许生成细节锚草案
- 无 shotId → `video_plan_required`
- 5 秒拆 4 镜头 / 概念板直接转视频 → 校验拒绝
- 本轮新建镜头 → `video_plan_unconfirmed`
- 本轮新锚图未确认 → `canon_unconfirmed`
- 开盖/内部状态缺细节锚图 → `product_state_reference_required`
- 否定句里的“开盖/螺纹/内胆”不触发状态要求
- 缺 canon → 关键帧/出片均 `canon_required`
- 关键帧自动以 canon 为第一参考图
- 缺首帧 → `keyframe_required`
- 首帧没有 canon 血缘 → `keyframe_not_anchored`
- 已确认 canon + 首帧 → 放行
- 首帧本轮新出 → `keyframe_unconfirmed`
- 多镜头首镜缺尾帧 → `end_frame_required`
- 上一镜没视频 → `previous_video_required`（出片时仍然强制按镜序）
- 下一镜出片时自动改用上一镜实际末帧作起始帧
- 预生成首帧不再要求含上一镜末帧血缘（批量前期）
- 两镜末帧接通 → 放行
- 重做同一镜首帧 → 当前已确认首帧是第一参考
- loose 无 canon/首帧 → 允许直接生成草稿；loose 多镜头 → 不强制末帧衔接
- `direct=true`：有主体图的单条 image-to-video，或用户原话显式授权；否则拒绝