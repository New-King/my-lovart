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
- [ ] 持久化线程与画布/文件
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

- [x] migration 0002：messages 补 attachments / parts / steps / status / failure / options / updated_at（已写，待执行）
- [ ] workspace repository：消息与画布读写切 Supabase，保留内存缓存
- [ ] canvas elements 落 `canvases`，读写在服务端完成
- [ ] Excalidraw files 落 Supabase Storage（bucket `project-files`），客户端按需取
- [ ] 附件 asset_id 改稳定 id（附件表 id / 内容 hash）
- [ ] 接 LangGraph PostgresSaver checkpointer + thread_id
- [ ] 历史裁剪与视觉附件预算（压缩、最多张数）
- [ ] workspace 路由校验 project 归属

验收：重启服务后，同一 project 的消息、画布、图片、参考图全部还在；同一个 thread 能继续上下文。

## Phase 2 · 生成作业化

目标：慢任务不堵 Agent，失败可恢复。

- [ ] `background_jobs` + worker（Supabase 表轮询或 PGMQ）
- [ ] 图片/视频工具改为提交作业 + 等待，超时返回 jobId
- [ ] 重试、取消、失败码、进度
- [ ] 结果落 Storage，服务端计算画布 placement
- [ ] 视频播放/编码问题一起解决

验收：视频生成期间可以取消；刷新后作业继续；超时后结果晚报也能自动上画布。

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

- [ ] 结构化 trace：runId / threadId / toolCallId / 耗时 / 错误码
- [ ] golden 场景自动跑
- [ ] LangSmith 可选，等需要系统调 prompt/工具时再接

## 比 Lavart 更强的差异点

- 追问协议：信息少用 Markdown，只差一个离散项才出候选答案按钮（Lavart 没有）
- 文字/图片交错渲染（已做）
- 服务端校验画布命令、前端执行（安全且可回放）
- 持久化 + 作业层 + golden 场景，形成可回归的工程质量

## 下一步（只做这一件）

先完成 Phase 0 的两份规格文档，然后按 Phase 1 落 migration 和 workspace repository。  
在 Phase 0 未完成前，不接受任何新的 UI / 提示词临时改动。