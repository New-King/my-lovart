# my-lovart Roadmap

> 这份文件是长期计划，不依赖聊天记录。每完成一个阶段就更新这里的状态和下一步。
> 最后更新：2026-11-14

## 北极星

主链路（对话 → 需求确认 → 生成图/视频 → 画布编辑）必须**超过 Lavart**，不是追平：

- 更少的无效追问，更准确的“什么时候该问 / 该做”
- 附件、截图、生成结果跨轮不丢
- 生成任务可取消、可重试、可恢复，刷新/重启不丢状态
- Agent 能真正改画布（文字、形状、样式），不只是挪图片
- 每一轮行为都有 golden 场景兜底，不靠截图验收

## 不可妥协的规则

1. 不再用“改一句提示词 / 加一个按钮”解决症状；先判断属于哪一层。
2. 任何 prompt / UI / 工具行为改动，必须先有对应的 golden 场景。
3. 每一阶段必须有验收标准、typecheck、真实模型手测、独立 git 提交。
4. 计划、状态、下一步只写进本文件和 `docs/specs/`，不依赖聊天上下文。
5. 不引入 skills / 品牌套件 / 计费；除非用户明确要求。

## 当前状态

- [x] 真实图片（Seedream）与视频（MiniMax）provider 接通
- [x] LangGraph + deepagents 工具循环，模型自选生成/画布操作
- [x] SSE 统一事件、取消、失败卡片、重试
- [x] 画布批量落位、整理、Agent 画布命令（移动/缩放/删除/对齐/分布/层级/透明度）
- [x] 开场引导、两档追问（Markdown 清单 / `offer_choices` 候选答案按钮）
- [x] 文字与产物交错渲染
- [x] 参考图视觉输入（最近 4 张 image_url）
- [x] 输入框收敛为 + / 发送，画幅交给模型
- [x] 持久化线程与画布/文件
- [ ] 产物账本（标题/prompt/模型/血缘/版本）
- [ ] 分镜与镜头状态
- [ ] 生成作业队列
- [ ] 画布工具深度（add_text/add_shape/add_line/update_text/update_style）
- [ ] golden 场景自动化
- [ ] 可观测 trace

## Phase 0 · 行为契约与验收基线（当前）

目标：把“什么算对”固定下来，之后所有改动都对着它验收。

- [x] 审计 Lavart 全链路（`docs/notes/AUDIT-vs-lavart.md`）
- [x] 写《对话行为契约》`docs/specs/conversation-contract.md`
- [x] 写 15 条 golden 场景 `docs/specs/golden-scenarios.md`
- [ ] 建一个最小可执行的场景检查脚本（先支持真实模型手测记录，不追求全自动）
- [x] 用当前实现跑一遍 golden，记录失败项（`docs/specs/golden-results.md`）

验收：每条 golden 都有明确 expected / forbidden 行为，后续改动必须引用场景编号。

## Phase 1 · 持久化线程与文件

目标：刷新、重启、跨轮都不丢，解决“上次还好好的”。

### 1a / 1b · 已完成

- [x] migration 0002：messages 补 attachments / parts / steps / status / failure / options / updated_at（已执行）
- [x] workspace repository：消息与画布读写切 Supabase，保留内存缓存
- [x] canvas elements 落 `canvases`，读写在服务端完成
- [x] Excalidraw files 落 Supabase Storage（bucket `project-files`），客户端按需取
- [x] 附件 asset_id 改稳定 id（`asset-${attachment.id}`）
- [x] workspace 路由校验 project 归属
- [x] 持久化验收脚本 `pnpm --filter @my-lovart/server verify:persistence`

### 1c · 产物账本（下一步）

目标：生成图片/视频的标题、完整 prompt、模型、来源、版本，下一轮还能准确找到。

- [ ] migration 0003：`project_assets`
- [ ] `ImageBlock`/`VideoBlock` 增加 `title`，工具结果写入完整 prompt 与 `sourceAssetIds`
- [ ] artifact 落库为不可变资产；画布元素写 `customData.assetId`
- [ ] 每轮注入 `<project_assets>` 摘要
- [ ] `list_assets` / `get_asset` 工具
- [ ] `verify:assets` 验收脚本，跑 G16/G22

验收：删掉画布图片后，仍能用「刚才那张咖啡海报」找到 asset_id 和 prompt 并改图。

### 1d · 执行记忆

- [ ] 接 LangGraph PostgresSaver checkpointer + thread_id
- [ ] 历史裁剪与视觉附件预算（压缩、最多张数），避免 checkpointer 与手工 history 重复
- [ ] 工具消息裁剪策略

验收：重启后同一 thread 能继续上下文；工具调用细节可恢复；上下文不随轮次无限膨胀。

## Phase 2 · 生成作业化

目标：慢任务不堵 Agent，失败可恢复。

- [ ] `background_jobs` + worker（Supabase 表轮询或 PGMQ）
- [ ] 图片/视频工具改为提交作业 + 等待，超时返回 jobId
- [ ] 重试、取消、失败码、进度
- [ ] 结果落 Storage，服务端计算画布 placement
- [ ] 视频播放/编码问题一起解决

验收：视频生成期间可以取消；刷新后作业继续；超时后结果晚报也能自动上画布。

## Phase 2.5 · 分镜与镜头

目标：分镜不是一长串自然语言，而是可查询、可重置、可回退的结构化状态。

- [ ] migration 0004：`storyboards` / `storyboard_shots` / `storyboard_revisions`
- [ ] `get_storyboard` / `create_storyboard` / `update_shot` / `reorder_shots`
- [ ] `reset_shot` / `reset_storyboard` / `restore_storyboard` / `set_shot_asset`
- [ ] 每轮注入 `<project_state>` 分镜摘要
- [ ] 生成工具支持 `shotId` / `sourceAssetIds`，结果自动挂到镜头 active
- [ ] 跑 G17–G21、G23

验收：能改第 3 个镜头、重置后恢复、在两个分镜之间精确切换，不靠模型记忆猜。

## Phase 3 · 工具深度

目标：Agent 能完成真实设计排版，不只会挪图片。

- [ ] manipulate_canvas 增加 add_text / add_shape / add_line / update_style / update_text
- [ ] bindings / 级联删除 / 写锁
- [ ] inspect_canvas 增加 element_id / filter_type / filter_region
- [ ] 视需要增加 project_search
- [ ] 工具结果返回稳定 elementId，供后续引用

验收：可以一句话让 Agent 加标题、画箭头、改颜色、对齐、删掉指定元素，并持久化。

## Phase 4 · UI 收敛

- [ ] 输入框只保留 + / 发送（已完成）
- [ ] 工具卡片按类型展示，产物与文字交错（已完成）
- [ ] 失败/取消/重试/刷新状态一致
- [ ] 不暴露内部参数；模型偏好等需要时再加

## Phase 5 · 可观测与评测

- [x] 每 run JSONL trace：请求附件 → 归一化 → 视觉上下文 → 模型请求 → 工具 → 回答/错误（`.traces/`，`trace:latest`）
- [x] `/health` 返回 pid / startedAt / traceDir，能确认请求打到哪个进程
- [ ] golden 场景自动跑
- [ ] LangSmith 可选，等需要系统调 prompt/工具时再接

## 比 Lavart 更强的差异点

- 追问协议：信息少用 Markdown，只差一个离散项才出候选答案按钮（Lavart 没有）
- 文字/图片交错渲染（已做）
- 服务端校验画布命令、前端执行（安全且可回放）
- 持久化 + 作业层 + golden 场景，形成可回归的工程质量

## 下一步（只做这一件）

Phase 1c：migration 0003 建 `project_assets`，把 artifact 的 title/prompt/model/血缘落库，并每轮注入 `<project_assets>` + `list_assets/get_asset`。  
在资产账本跑通前，不动分镜工具，也不把分镜数据塞进自然语言历史。