# my-lovart Roadmap

> 这份文件是长期计划，不依赖聊天记录。每完成一个阶段就更新这里的状态和下一步。
> 最后更新：2026-11-17（重新审计 Phase 2 完成度、provider 注册表与灵感搜索之后）

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
6. “功能做完”不等于“可交付”：每个阶段按 [`docs/specs/reliability-invariants.md`](docs/specs/reliability-invariants.md) 检查失败边界、跨进程读写、stale 写入和首屏反馈；只测 happy path 不算验收。

## 阶段完成度（2026-11-17 审计）

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0 行为契约 | 完成 | 契约、golden 场景、失败记录都有；自动检查脚本仍未做 |
| Phase 1 持久化 | 完成 | 消息/画布/附件/文件/checkpoint 均已真实读写验证 |
| Phase 2 生成作业化 | 2a 完成，2b 未收尾 | 作业队列、worker、画布写入通过；视频真机播放与真实取消未手测，错误分类/限流未做 |
| Phase 2.5 分镜与视频前期 | 核心完成 | strict/adaptive/loose、锚图组、首尾帧、末帧衔接通过；拼接成片不做（用户明确延后） |
| Phase 3 画布工具深度 | 未开始 | 目前只能移动/缩放/删除/对齐/分布/层级/透明度 |
| Phase 4 UI 收敛 | 大部分完成 | 输入框、交错渲染、过程行已做；取消/失败/刷新的一致状态依赖 2b 手测 |
| Phase 5 可观测与评测 | 部分完成 | JSONL trace 与 `/health` 已做；golden 自动跑未做 |

## 当前状态

- [x] 真实图片（Seedream 4.5，可切换渠道）与视频（MiniMax，可切换模型）provider 接通
- [x] 生成渠道注册表：模型元数据、按 key 条件注册、默认模型解析、只读模型目录接口（M28）
- [x] LangGraph + deepagents 工具循环，模型自选生成/画布操作
- [x] SSE 统一事件、取消、失败卡片、重试
- [x] 画布批量落位、整理、Agent 画布命令（移动/缩放/删除/对齐/分布/层级/透明度）
- [x] 开场引导、两档追问（Markdown 清单 / 逐题提问卡：每题 A–D + 自定义，两组可见，答完自动滚下一组）
- [x] 文字与产物交错渲染
- [x] 参考图视觉输入（最近 4 张 image_url）
- [x] 输入框收敛为 + / 发送，画幅交给模型
- [x] 持久化线程与画布/文件
- [x] 素材库按用户入库（migration 0014；刷新/重启后仍在）
- [x] 产物账本（标题/prompt/模型/血缘/版本）
- [x] 分镜与镜头状态（结构化仓库 + 工具 + 上下文；分镜 UI 待做）
- [x] 生成作业队列（图片/视频；视频画布 embeddable 与内联播放已做，真机待验）
- [x] 生成过程单行动态状态（流光 + 秒数），默认折叠；所有工具步骤可展开输入/输出
- [x] 画布 revision 乐观锁 + 跨进程刷新；生成图落画布后前端聚焦并提示
- [ ] 画布工具深度（add_text/add_shape/add_line/update_text/update_style）
- [ ] golden 场景自动化
- [x] 视频前期 golden 对话回放脚本（真实模型，停在视频前，输出自包含 HTML；M30）
- [x] 普通用户版视频前期回放 + Lavart 视频流程审计（M31，8/8）
- [x] 灵感搜索 `search_inspiration`（Pexels adapter + 方向卡片 + “第 N 组第 M 张”文字选图；M32，契约 12/12、真实模型回放 5/5；真实 key 待配置）
- [x] 素材库入库：`user_materials` + Storage + 删除清理，刷新/重启不丢（M33，11/11）
- [ ] 可观测 trace

## Phase 0 · 行为契约与验收基线（已完成）

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

### 1c · 产物账本（已完成）

目标：生成图片/视频的标题、完整 prompt、模型、来源、版本，下一轮还能准确找到。

- [x] migration 0003：`project_assets`（已执行）
- [x] `ImageBlock`/`VideoBlock` 增加 `title`，工具结果写入完整 prompt 与 `sourceAssetIds`
- [x] artifact 落库为不可变资产；画布元素写 `customData.assetId / title`
- [x] 每轮注入 `<project_assets>` 摘要
- [x] `list_assets` / `get_asset` 工具
- [x] `verify:assets` 验收脚本

验收：删掉画布图片后，仍能用「刚才那张咖啡海报」找到 asset_id 和 prompt 并改图。  
验证记录：`docs/notes/M15.md`；真实 HTTP 问标题返回正确，mock 生成 3 个 artifact 全部入账。

### 1d · 执行记忆（已完成）

- [x] 接 LangGraph PostgresSaver checkpointer + thread_id（migration 0004 已执行）
- [x] 历史裁剪与视觉附件预算（压缩、最多张数），避免 checkpointer 与手工 history 重复
- [x] 工具消息裁剪策略（deepagents 内置 SummarizationMiddleware）
- [x] `/health` 暴露 checkpointer 状态；未安装依赖时自动降级

验收：重启后同一 thread 能继续上下文；工具调用细节可恢复；上下文不随轮次无限膨胀。  
验证记录：`docs/notes/M16.md`；真实模型两轮 + 杀进程重启第三轮，均正确回答 ORBIT-9。

## Phase 2 · 生成作业化

目标：慢任务不堵 Agent，失败可恢复。

### 2a · 已完成

- [x] `background_jobs` + 表队列 + claim RPC（migration 0005 已执行）
- [x] API 进程内 worker（并发 2，重启继续；失败按 attempt 重试）
- [x] 图片/视频工具改为提交作业 + 等待，超时返回 jobId
- [x] 结果落 Storage/资产账本；图片由服务端计算 placement + 写锁直接上画布
- [x] 前端 artifact 带 elementId 时只刷新；tool.failed 带 jobId 走 fallback 轮询
- [x] 项目删除清理 Storage 与 checkpoint

验收：真实 Seedream 作业 29.4s 成功，资产/画布/artifact 一致；记录 `docs/notes/M17.md`。

### 2b · 未收尾（Phase 2 不能算完成）

- [x] 视频画布元素与内联播放（embeddable + renderEmbeddable；**真机播放仍待用户验证**）
- [x] 工具卡片持续进度（worker → job 进度 → tool.progress）
- [x] 取消链路代码：停止按钮断 SSE → 服务端 abort → 工具等待 abort → `cancelJob` → worker abort provider（`docs/notes/M17.md`）
- [ ] 生成中取消真实手测（图片/视频各一次；代码完成不等于验收）
- [ ] 视频在画布与对话里实际播放（用户环境）
- [ ] 非重试错误分类、限流与多实例公平性

完成定义：上面 3 个未勾选项有手测记录（截图或 trace），才把 Phase 2 标为完成。2026-11-17 重跑 `verify:persistence / attachments / assets / video-guard 30/30 / video-frame / generation-config 11/11` 均通过，说明近期 provider 注册表、一致性策略、灵感搜索没有破坏 Phase 1–2 的既有契约；但真机播放/取消仍未验证。

## Phase 2.5 · 分镜与镜头

目标：分镜不是一长串自然语言，而是可查询、可重置、可回退的结构化状态。

- [x] migration `0009`：`storyboards` / `storyboard_shots` / `storyboard_revisions`（原计划 0004 已被 thread_id 占用）
- [x] `get_storyboard` / `create_storyboard` / `update_shot` / `reorder_shots`
- [x] `reset_shot` / `reset_storyboard` / `restore_storyboard` / `set_shot_asset`
- [x] 每轮注入 `<project_state>` 分镜摘要（只展开 active 分镜）
- [x] 生成工具支持 `shotId`，结果自动挂到镜头 active（图片真实生成已验证）
- [x] 视频前期闸门：脚本 + 首帧未确认时拒绝 `generate_video`，`direct=true` 才可跳过（M22，6/6 脚本验收）
- [x] Phase 3a 视频前期三层：canon 设定图、基于 canon 的关键帧、镜头 4-15 秒时长规则（M23，12/12）
- [x] Phase 3b 连贯性：产品/角色/场景/主视觉锚图组，首尾帧链，上一镜末帧承接下一镜（M24，17/17）
- [x] Phase 3c 实拍锚定与实际末帧：canon 必须基于产品实拍、canon 确认门禁、ffmpeg 抽末帧、按镜序闭环（M25，20/20 + frame）
- [x] Phase 3d 产品状态锚图：开盖/螺纹/内胆必须补 product_detail 实拍，否则拒绝关键帧（M27，24/24）
- [x] Phase 3e 一致性策略可配置：strict / adaptive / loose，客户无参考图不再被全局流程卡死（M29，30/30）
- [x] 默认生图模型切 Seedream 4.5（2K 画幅 + 模型目录 + 展示名解析，M28，11/11）
- [x] 灵感方向不是强制前置：无方向时先看图选，再生成（M32，契约 12/12 + 回放 5/5）
- [x] 视频流程改为条件路径：单条 image-to-video 直接出；多镜头有参考图走 referenceDirect（不生成关键帧/设定图）；用户参考图可直接登记 canon（M34，probe 5/5 + guard 35/35）
- [x] 回合收尾规则：不再用“确认后我就…”空承诺结束；可逆的 canon/登记同轮做完，只有出片/批量关键帧才等确认（M35，probe 4/4）
- [ ] 多镜头视频拼接成片（ffmpeg/供应商合成；用户明确延后）
- [ ] 跑 G21（40 资产上下文预算）、G23（生成失败保留状态）；G17–G20 已通过

验收：能改第 3 个镜头、重置后恢复、在两个分镜之间精确切换，不靠模型记忆猜。真实模型已验证（`docs/notes/M21.md`）。

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

- 追问协议：信息少用 Markdown，只差离散项时出逐题提问卡（每题可自定义、可跳过；Lavart 没有）
- 文字/图片交错渲染（已做）
- 服务端校验画布命令、前端执行（安全且可回放）
- 持久化 + 作业层 + golden 场景，形成可回归的工程质量

## 下一步（只做这一件）

收尾 Phase 2b：先按 [`docs/specs/manual-tests.md`](docs/specs/manual-tests.md) 真实播放一次视频、生成中取消一次（图片或视频），记录结果；随后补非重试错误分类与限流。完成后再进入 Phase 3 画布工具深度（add_text / add_shape / add_line / update_style / update_text）。

视频前期的 strict 分支仍需要客户真实实拍（当前手头没有）；有实拍后按 M26/M29 跑一次，不能拿生成图冒充实拍。真实 Pexels 搜索需要 `PEXELS_API_KEY`。