# 视频前期：设定图、关键帧、镜头时长与一致性

> 状态：Phase 3a 已实现（多镜头拼接未实现）
> 最后更新：2026-11-15
> 关联：`docs/notes/M23.md`、`docs/specs/project-state-and-storyboard.md`

## 问题

用户要保温杯视频，模型直接建了 4 个镜头、分别文生图。4 张图里杯子形状/材质各不相同，看起来像 4 个不同产品。trace 显示每次 `generate_image` 只有 prompt 和 shotId，没有 `inputImages`，也没有共享的产品参考；分镜的 `active_asset_id` 还把图片和视频混在同一个指针里。

这不是“图片模型不稳定”，而是前期缺了三层：

1. 没有产品/角色设定图（canon），每个镜头各自从文字重新发明产品；
2. 没有区分“视觉设定 / 分镜关键帧 / 成片片段”，4 张图既不是连贯分镜，也不是视频输入；
3. 没有时长预算：5 秒拆 4 段，每段 1-2 秒，低于视频 provider 单段最短 4 秒，根本不能逐段出片。

## 对比 Lavart

Lavart 仓库没有这套前期模型：

- `apps/server/src/agent/tools/video-generate.ts` 的 `inputImages` 最多 7 张，第一张作为首帧，仅此而已；
- `apps/web/src/components/canvas/video-generator-panel.tsx` 提供首帧/尾帧上传；
- `apps/server/src/agent/prompts/loomic-main.ts` 只有“视频 → generate_video”，没有脚本、设定图、分镜或确认规则；
- 没有任何 storyboard/shot/canon 数据表。

所以照抄 Lavart 解决不了产品一致性。它把一致性交给用户上传和模型自觉；我们必须在服务端把“共享参考”变成硬约束。

## 三层产物

| 层 | 角色 | 数量 | 是否进视频 | 生成方式 |
| --- | --- | --- | --- | --- |
| 产品/角色设定图 | `canon` | 整条片 1 张 | 否，只做参考 | 用户实拍图做参考，或文生图；确认后锁定 |
| 分镜关键帧 | `keyframe` / `end_frame` | 每个镜头 1 张首帧，尾帧可选 | 首帧作为视频第一帧 | 必须引用 canon；相邻镜头可再加上一帧 |
| 成片片段 | `video` | 每个镜头 1 条 | 最终交付 | `generate_video(shotId)`，首帧/时长由镜头锁定 |

关键帧不是“每个镜头各自文生图”。`planImageReferences` 在生成关键帧时自动把该分镜的 canon URL 放到参考图第一位；生成结果记录 `metadata.role=keyframe` 和 `sourceAssetIds=[canon_id]`。出片前预检会校验这两个字段，手工塞一张图当首帧会被 `keyframe_not_anchored` 拒绝。

## 时长与镜头数

视频 provider 单段最短 4 秒、最长 15 秒，所以镜头数必须由总时长反推：

- 5 秒 → 1 个镜头（1 张首帧，可选 1 张尾帧），不是 4 张；
- 10 秒 → 最多 2 个镜头（建议 5+5）；
- 15 秒 → 最多 3 个镜头（建议 5+5+5）；
- 规则：每镜头 4-15 秒，合计必须等于总时长，镜头数 ≤ `floor(总时长 / 4)`。

`create_storyboard(kind="video")` 会校验；5 秒拆 4 段直接报错。纯视觉分镜用 `kind="image"`，没有时长约束，但那只是概念图，不是可执行视频时间线。

## 数据模型

migration `0010_video_preproduction.sql`（已执行）：

- `storyboards.kind`：`image` / `video`
- `storyboards.canon_asset_id`：设定图
- `storyboards.total_duration_seconds`：成片总时长
- `storyboard_shots.first_frame_asset_id` / `end_frame_asset_id` / `video_asset_id`

旧的 `active_asset_id` 只保留兼容；新代码按角色写独立指针，避免“生成视频后把首帧指针覆盖掉”。

## 流程

1. 需求：平台/画幅、总时长、基调；问用户有没有产品实拍图。
2. 脚本：按镜头列画面、运镜、节奏、字幕。
3. `create_storyboard({kind:"video", totalDurationSeconds, shots})`：只写文字时间线。
4. `create_storyboard` 后生成 canon：`generate_image({role:"canon", storyboardId, inputImages:[产品图]})`；展示并确认。
5. 逐镜头 `generate_image({shotId, role:"keyframe"})`：自动基于 canon；需要落点时加尾帧。
6. 给用户看 canon + 脚本 + 镜头表 + 关键帧，停止。
7. 下一轮确认后，逐镜头 `generate_video({shotId})`；首帧和时长由镜头锁定。
8. 多镜头全部完成后，才进入拼接成片。

## 仍未实现

**多段视频拼接**。当前 `generate_video` 一条只生成一个镜头的 clip；10 秒 2 个镜头会得到 2 条 5 秒视频，还不会自动合成一条 10 秒成片。拼接需要 ffmpeg 或供应商合成能力，是下一步，不能在 UI/文案里假装已经完成。

## 验收

`apps/server/scripts/verify-video-guard.mjs`，12/12 通过，不调用图片/视频 provider：

- 无 shotId → `video_plan_required`
- 5 秒拆 4 镜头 → 校验拒绝
- 本轮新建镜头 → `video_plan_unconfirmed`
- 缺 canon → 关键帧/出片均 `canon_required`
- 关键帧自动以 canon 为第一参考图
- 缺首帧 → `keyframe_required`
- 首帧没有 canon 血缘 → `keyframe_not_anchored`
- 已确认 canon + 首帧 → 放行
- 首帧本轮新出 → `keyframe_unconfirmed`
- `direct=true` 显式跳过