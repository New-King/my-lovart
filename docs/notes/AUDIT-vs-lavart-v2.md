# Lavart 全量对照审计 · v2

> 目的：回答“到底有没有完整看 Lavart、哪些是我们也要做的、还缺什么”。  
> 方法：逐目录读 `apps/server/src`、`apps/web/src`、`packages/shared/src`、`supabase/migrations`，不是只看提示词。  
> 范围：以“图片/视频生成 + Agent + 画布 + 分镜”为主线；skills / brand kit / credits / pricing 明确不做，但会标出来源。

## 0. 结论

Lavart 真正的专业度不在提示词，而在五条工程链路：

1. **执行记忆**：LangGraph checkpointer + `thread_id`，工具调用与结果跨轮/跨进程恢复。
2. **异步作业**：`background_jobs` + PGMQ worker，图片/视频长任务不堵 Agent，超时后 worker 继续，前端轮询补偿。
3. **服务端画布写入**：作业完成后由服务端计算 placement、加写锁、直接写画布，用户关页面也能收到结果。
4. **产物元数据**：工具结果带 title/prompt/elementId，画布元素带 `customData.title`，上下文能引用。
5. **完整的画布生成面**：图片/视频生成面板、视频播放元素、图层面板、文件面板、模型选择。

我们目前有 1 的骨架（SSE/取消/重试）和部分画布命令，但 1 的持久化、2、3、4 都没有；5 只有聊天内生成。  
所以“看起来能用”但一遇到长任务、刷新、分镜、版本就会塌。

## 1. Agent 运行时

| 能力 | Lavart | my-lovart 现状 | 结论 |
| --- | --- | --- | --- |
| Agent 框架 | deepagents + LangGraph | 同 | 已有 |
| 执行记忆 | `PostgresSaver` + `thread_id`（`agent/persistence/*`、`runtime.ts:1115`） | 手工 `history` 只取 role+content，最多 20 条 | **P0 缺** |
| 会话/线程 | `chat_sessions` 一对一 `thread_id`，可多会话 | 每项目单 session，无 thread | **P1 缺**（多会话可延后，thread 不能） |
| 流式传输 | WebSocket + 事件缓冲/重连 | SSE + AbortController | 可用；重连恢复 **P1** |
| 工具调用结果 | ToolMessage 进 checkpoint，跨轮保留 | 仅当前 run 可见 | **P0 缺** |
| 取消 | run cancel + worker 取消 | SSE 断开取消 | 已有，但作业取消缺 |
| 运行元数据 | `agent_runs` 表（model/status/error/thread） | 无 | P2 |
| 子 Agent | 视频子 Agent | 无 | P2（可后做） |
| 思考流 | `thinking.delta` 事件 | 只展示正文/步骤 | P2 |
| 错误脱敏 | `error-sanitizer.ts` | 基本错误映射 | P1 |
| 视觉附件 | 下载→压缩/尺寸预算→image_url（`vision-attachments.ts`） | image_url，无压缩/预算 | **P1 缺** |
| 上下文预算 | 依赖 checkpoint，无显式裁剪 | 20 条文本，无 token 预算 | **P1 缺** |

## 2. 生成链路

| 能力 | Lavart | my-lovart 现状 | 结论 |
| --- | --- | --- | --- |
| 图片 provider | 多 provider registry（Volces/OpenAI/Google/Replicate） | 只有 Volces Seedream | 够用；模型选择 P2 |
| 视频 provider | 多 provider（Metaso/Google/Replicate/Wan） | 只有 Metaso MiniMax | 够用；模型选择 P2 |
| 同步生成 | 直接 `/api/agent/generate-image|video` 给画布面板 | 只有 Agent 工具内同步 | **P0 缺**（画布面板依赖） |
| 异步作业 | `background_jobs` + PGMQ + worker + 重试/VT 续期 | 无，工具内 await 直到完成 | **P0 缺** |
| 超时/重试/取消 | 作业状态机 + attempt + dead letter + cancel | AbortController，无 jobId | **P0 缺** |
| 超时后结果补偿 | `use-job-fallback-polling` 5s 轮询，成功刷新画布 | 无 | **P0 缺** |
| 结果持久化 | worker 下载→Storage→asset_objects→public URL | 工具内下载→Storage→/files | 部分已有；无作业记录 |
| 视频播放 | Excalidraw embeddable + `VideoCanvasElement` 内联播放 | 视频只回聊天，不上画布 | **P0 缺** |
| 画布自动落位 | 服务端 `calculateAutoPlacement` + write lock | 客户端插入，服务端命令 | **P0 缺**（作业化前提） |
| 生成设置 | 模型/比例/质量/时长/分辨率/首尾帧面板 | 画幅交给 Agent；无面板 | **P1 缺** |
| 模型列表 | `/api/image-models` `/api/video-models` | 无 | **P1 缺** |

## 3. 画布

| 能力 | Lavart | my-lovart 现状 | 结论 |
| --- | --- | --- | --- |
| 编辑器 | Excalidraw | 同 | 已有 |
| 画布保存 | 50MB bodyLimit，服务端 content 保存 | 64MB，服务端保存 + Storage files | 已有，优于 |
| 写锁 | `canvas-write-lock.ts` | 无（Agent 命令走客户端） | **P1 缺** |
| 图层 | `canvas-layers-panel` | 无 | P1 |
| 文件面板 | `canvas-files-panel` | 素材库面板部分替代 | P1 |
| 图片生成面板 | `canvas-image-gen-panel` | 无 | **P1 缺** |
| 视频生成面板 | `video-generator-panel` 640 行（首尾帧/模型/时长/分辨率） | 无 | **P1 缺** |
| 视频元素 | embeddable 内联播放 | 无 | **P0 缺** |
| 画布截图给模型 | `canvas_screenshots` bucket | 无 | P2 |
| inspect_canvas | summary/full、element_id、filter_type、filter_region | 只有摘要 | **P1 缺** |
| manipulate_canvas | move/resize/delete/align/distribute/reorder/update_style/add_text/add_shape/add_line/update_text | 无 add_*/update_* | **P1 缺** |
| 元素 id 稳定返回 | 工具结果带 elementId | 命令无 elementId | P1 |
| 缩略图 | project thumbnail 上传 | 无 | P2 |
| 下载/预览 | 有 | 有 | 已有 |

## 4. 上下文与资产

| 能力 | Lavart | my-lovart 现状 | 结论 |
| --- | --- | --- | --- |
| 画布摘要 | 每轮注入，30 元素上限 | 同，60 元素 | 已有 |
| 画布图片 title | `customData.title` | `customData.name = prompt` | **P0 缺**（信息错位） |
| 生成产物 title/prompt | ToolMessage + canvas title | title 未入 artifact；prompt 截 200 且不进历史 | **P0 缺** |
| 资产血缘/版本 | 无显式表 | 无 | **P0 缺**（我们要超过） |
| 项目资产账本 | 无（仅 asset_objects 文件） | 无 | **P0 缺**（分镜基础） |
| 分镜/镜头 | 无 | 无 | **P0 缺**（我们独有需求） |
| 项目搜索 | sandbox `project_search` | 无 | P2 |
| 附件跨轮 | vision attachments 准备 | 最近 8 张重注入 | 已有 |
| 附件压缩 | 有 | 无 | P1 |

## 5. 项目与账号

| 能力 | Lavart | my-lovart 现状 | 结论 |
| --- | --- | --- | --- |
| 项目 CRUD | 有，软删除 archived_at | 有，硬删除 | 已有 |
| 项目缩略图 | 有 | 无 | P2 |
| 会话选择器 | 有（搜索/新建/删除） | 无 | P1（用户曾允许延后） |
| 上传接口 | `/api/uploads` + asset_objects | 附件 data URL 入库 | P1 |
| 工作区设置 | 默认模型 | 无 | P2 |
| 登录 | Supabase Auth | 同 | 已有 |
| 骨架屏/toast/错误边界 | 有 | 有 toast/skeleton/lightbox，无 error boundary | P1 |
| 首页/定价/登录页 | 有完整 landing/pricing | 有 landing/login | 已有（不做 pricing） |

## 6. 明确不做（Lavart 有、我们不需要）

- skills marketplace / skill files / workspace skills
- brand kit 编辑器/选择器/字体库
- credits、tier guard、watermark、payments/Lemon Squeezy
- 首页 discovery/home example 库
- article illustrator 等特定 skill 工作流

## 7. 优先级（按“专业生成产品”最低线）

**P0：不做就不配叫完成**

1. 产物账本（title/完整 prompt/model/血缘/版本）+ `<project_assets>` + `list_assets/get_asset`。
2. PostgresSaver checkpointer + `thread_id`，替代手工 history。
3. 异步作业（image/video job + worker + 超时/重试/取消 + fallback polling）。
4. 服务端画布写入（自动落位 + 写锁），作业完成不依赖页面在线。
5. 视频画布元素与内联播放。

**P1：专业体验**

6. 画布图片/视频生成面板 + 模型列表。
7. manipulate_canvas 深度（add_text/shape/line/update_style/update_text）+ inspect 过滤。
8. 多会话、图层面板、文件面板、上传 API、项目缩略图。
9. 视觉附件压缩/预算、上下文 token 预算、错误脱敏。

**P2：增强**

10. 子 Agent、thinking 流、运行元数据、画布截图、项目搜索、模型偏好设置。

## 8. 本轮立即执行

Phase 1c 产物账本：`migration 0003`、artifact title/完整 prompt/sourceAssetIds、`project_assets` 落库、`<project_assets>` 注入、`list_assets/get_asset`、画布 `customData.assetId`、`verify:assets`。  
它先解决“上一轮生成的图片简介/提示词下一轮找不到”，也是分镜镜头挂载资产的前提。

后续顺序不再变：1c → 1d checkpointer → 2 作业+服务端画布写入+视频播放 → 2.5 分镜 → 3 工具深度 → 4/5 体验与评测。