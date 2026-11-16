# 视频连续性改造交接：产品漂移与首尾帧衔接

> 状态：P0/P1 已落地（2026-11-16），实现记录见 `docs/notes/M25.md`；P2 未做。

> 写给负责改代码的 agent。本文只讲背景、现状、结论和要落地的改动，不含实现代码。

## 来龙去脉

1. 用户用 `my-lovart` 做一条保温杯产品视频，出分镜图时发现四张关键帧是**四个不同的产品**（细长瓶、螺纹口大瓶、两个小瓶加玻璃杯、宽口罐），完全没法剪成一条片子。
2. 排查后确定问题不在视频、也不在 `end_frame`，而是**产品锚点（canon）从第一步就不成立**：canon 允许没有参考图、纯文生图，等于让模型凭文字发明一只杯子；后续每张关键帧再以它为弱参考重新生成，于是每张都在重新发明。
3. 对照了两个参考：本地 `projects/Lavart`（克隆版）和真 Lovart。
   - `Lavart` 完全没这套流程：`generate_video` 单工具，`inputImages` 最多 7 张、第一张当首帧，没有分镜、没有 canon、没有首尾帧、没有生成前确认，一致性全靠用户自己传图。**不要照抄。**
   - 真 Lovart 有完整的：视频生成器里有「首尾帧」模式，Agent 工具带 `start_frame_image_url` / `end_frame_image_url` / `reference_image_urls`，另有 `media_finishing_agent` 做剪辑/转场/调色；一致性靠角色/道具素材库 + 多角度定妆卡 + 分镜模板沿用设定图。
   - 但 Lovart 的「参考图锚定」同样锁不住身份（保温杯已经实证），它真正强的是**帧级衔接**。
4. 结论：`my-lovart` 的流程方向是对的（甚至比 Lovart 的门禁更严），缺的是两件事——**canon 必须锚在真实产品图上**，以及**连续性要用视频实际抽出的末帧，而不是另外生成的尾帧图**。

## 现状（代码事实，改动前请对照确认）

出图链路 `apps/server/src/features/agent/tools.ts`：

- `planImageReferences()`（约 350 行起）按 `role` 决定参考图
  - `role=canon`：`references = explicit.slice(0, 4)`，**允许为空**，没有实拍图就是纯文生图；`anchorType` 默认 `product`
  - `role=keyframe`：锚图（canon / character / scene / style）最多 4 张 + 上一镜 `end_frame` + explicit，最后整体 `.slice(0, 4)`
  - `role=end_frame`：锚图 3 张 + 当前镜头首帧
  - prompt 会追加 `shotDirection`（`sceneGoal` / `continuityNote` / `negativePrompt`）
- `generate_image` handler 把 `referenceImages` 传给 `generateImageWithVolces`，参考图最终塞进 Volces 请求体的 `image: [...]` 字段

视频链路：

- `checkVideoPreflight()`（约 586 行起）门禁：脚本存在且已确认、`canonAssetId` 存在、首帧存在且 `sourceAssetIds` 含 canon、首帧跨轮确认（`keyframe_unconfirmed`）、上一镜 `endFrameAssetId` 存在且被承接、非收尾镜必须有 `end_frame`
- `generate_video` handler（约 880 行起）在镜头模式下由服务端锁定首尾帧：`frames = [firstFrame.url, endFrame.url]`，覆盖 `referenceImages`
- `apps/server/src/features/generation/metaso-video.ts:32`：`referenceImages[0]` → `content` 里 `role: "first_frame"`，`[1]` → `role: "last_frame"`
- `apps/server/src/features/jobs/worker.ts` 的 `executeVideoJob()`（约 240 行）：`payload.inputImages`（≤2）传给 `generateVideoWithMetaso`，成功后 `importRemoteFile` 落盘、写 `VideoBlock`、`applyVideo()` 回写 `video_asset_id`
- 数据表 `storyboard_shots` 已有 `first_frame_asset_id` / `end_frame_asset_id` / `video_asset_id`（`storyboards.repository.ts`）
- 全仓库**没有 ffmpeg**，也没有「视频末帧」相关字段

## 问题清单（按影响排序）

1. **canon 允许无参考图**。没有实拍图时，canon 是模型发明的产品，后面所有镜头都在这个虚构主体上继续漂。
2. **参考图不是身份锁定**。Seedream 的多图参考只是「参考」，不是 IP-Adapter/LoRA；每镜 prompt 又重述产品（"白色保温杯、木质瓶盖"），模型会按文字重新画。
3. **refs 太杂**。keyframe 一次最多 4 张（canon + character + scene + style + 上一镜尾帧），场景和风格图会稀释产品主体。
4. **连续性用的是生成图，不是真实末帧**。`end_frame` 是图片模型生成的图，只是视频生成时的"参考"，视频实际结尾很可能不落在那一帧；下一镜再以这张图为锚，等于连续两次近似，误差逐镜累积。
5. **没有 canon 确认门禁**。只有 `keyframe_unconfirmed`，canon 生成后同一轮就能继续出关键帧，用户没机会确认"是不是这只杯子"。

## 改造清单

### P0（必须先做，直接决定产品像不像）

1. **canon 强依赖实拍图**
   `planImageReferences()` 里，`role === "canon" && anchorType === "product"` 且解析后的 `references` 为空时，返回错误 `canon_photo_required`，文案提示上传产品实拍（正面 / 侧面 / 背面 / 俯视），并给出 `next` 指引。不允许再走纯文生图。

2. **canon 确认门禁**
   参照 `keyframe_unconfirmed` 的写法，在 `planImageReferences()` 或生成入口加 `canon_unconfirmed`：本轮的 canon（`createdAt >= runStartedAt - 2000`）不允许在同一轮直接用来出 keyframe，要求先给用户看、下一轮再继续。同时约束**一个分镜只有一个 product canon**，重复生成要覆盖而不是并存。

3. **keyframe prompt 改成锁定式**
   在 `generate_image` 组装 prompt 时追加固定块，例如：
   「严格保持参考图中的产品一致：形状、比例、瓶盖/接口结构、材质、颜色、logo 位置，不要重新设计产品；只允许改变机位、光线、背景与构图。」
   同时**去掉 prompt 里对产品的重复描述**，产品信息交给 canon 承担，文字只描述镜头。

4. **refs 收敛**
   `keyframe` 阶段默认只传：canon（必需）+ 上一镜衔接帧；`style` 可选，`scene`/`character` 不再默认塞进产品类镜头。总数建议 ≤3，避免稀释。

### P1（连续性正确性）

5. **视频末帧抽取**
   视频生成成功后（`worker.executeVideoJob` 落盘之后）用 ffmpeg 抽最后一帧：
   `ffmpeg -sseof -0.1 -i <video> -frames:v 1 -q:v 2 out.jpg`
   抽出的帧上传 Storage，登记为资产（`metadata.role = "video_last_frame"`），并在 `storyboard_shots` 新增 `video_last_frame_asset_id`（需要迁移）。抽帧失败不能让整个 job 失败，降级并记录。

6. **连续性改用实抽帧**
   - `checkVideoPreflight()`：上一镜的判断优先用 `previous.video_last_frame_asset_id`，没有才回退到 `endFrameAssetId`
   - `planImageReferences()` keyframe 的 continuity 引用：优先上一镜实抽帧的 url，其次才是 `end_frame`
   - 下一镜 keyframe 的 `sourceAssetIds` 必须包含上一镜的 `video_last_frame_asset_id`，门禁校验这条

7. **收敛 `end_frame` 的语义**
   `end_frame` 图只作为**本镜视频的 `last_frame` 约束**，不再作为下一镜首帧的来源。文档和工具描述同步改，避免两个来源混用。

### P2（可选，别当解决方案）

8. **生成后一致性校验**：keyframe 生成后调视觉模型，对比 canon 与 keyframe 是否同一产品，不一致返回 `keyframe_drift` 要求重生成（项目已有视觉通道）。
9. **后期统一观感**：拼接、叠化、统一调色。只影响观感，不影响身份一致性。

## 验收标准

- 不带实拍图请求产品 canon → 返回 `canon_photo_required`，不再产出图片
- 同一轮内 canon 刚生成就请求 keyframe → 被 `canon_unconfirmed` 拦住
- 视频生成完成后 `storyboard_shots.video_last_frame_asset_id` 非空，且抽帧尺寸与视频一致
- 生成第三镜 keyframe 时，其 `sourceAssetIds` 含第二镜的 `video_last_frame_asset_id`
- 四个镜头的关键帧肉眼是同一只保温杯，瓶盖、比例、材质一致

## 明确不做

- 不接新模型、不训 LoRA（现有 Seedream 能力下先靠 canon + 抽帧解决）
- 不改 `projects/Lavart` 克隆仓库
- 不把 `media_finishing` 类后期当作一致性方案

## 相关文件

- `apps/server/src/features/agent/tools.ts`（`planImageReferences` / `checkVideoPreflight` / `generate_image` / `generate_video`）
- `apps/server/src/features/generation/metaso-video.ts`
- `apps/server/src/features/jobs/worker.ts`（`executeVideoJob`）
- `apps/server/src/features/storyboards/storyboards.repository.ts`（`first_frame_asset_id` / `end_frame_asset_id` / `applyVideo`）
- `apps/server/src/features/generation/volces-image.ts`（参考图字段 `image`）