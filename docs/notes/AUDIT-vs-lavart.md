# my-lovart vs Lavart 全链路审计

日期：2026-11-14
范围：只对比「生成图/视频 + Agent 画布」这条主链路，不包含 Lavart 的 skills、品牌套件、计费、分享导出。

## 一句话结论

现在的 my-lovart 不是「提示词差一点」，而是缺了三层基础设施：**持久化线程记忆、异步生成作业、工具深度**。  
提示词、按钮、画布提示这些反复改，都是这三层缺失后冒出来的表面症状。

## 1. 端到端工作流对比

| 阶段 | my-lovart | Lavart | 影响 |
|---|---|---|---|
| 输入 | 文本 + 图片附件；输入框现在只有 + 和发送 | 文本 + 附件 + 模型偏好（Agent/图片/视频） | 我们默认模型，暂时不需要偏好 UI |
| 消息存储 | `workspace.store.ts` 内存 Map | Supabase `chat_messages`，保存 `content_blocks` / `tool_activities` | 重启后我们的对话全丢 |
| 上下文组装 | 最近 N 条消息文本 + 最近 8 张附件重注入 + 画布摘要 | checkpointer 线程状态 + 当前消息 + 当前附件 + 画布摘要 | 我们靠“重放 + 补丁”，Lavart 靠线程状态 |
| Agent 运行时 | deepagents 单 Agent，无 checkpointer/store | deepagents 主 Agent + 视频子 Agent，PostgresSaver + PostgresStore | 子任务、断点恢复、长期记忆都不同 |
| 工具循环 | 5 个自定义工具，模型自选 | 8 个自定义工具 + deepagents 内置文件/命令/任务工具 | 我们缺少添加文字/形状、项目检索、沙箱能力 |
| 生成执行 | 工具内同步调用 provider，下载到内存 | PGMQ 作业队列 + `background_jobs` 表 + worker，超时/重试/取消 | 我们一次慢请求就占住整轮；视频失败只能重来 |
| 画布写入 | 服务端下发 `canvas.command`，前端 Excalidraw 执行并自动保存 | 服务端加写锁直接改画布内容，插入元素后发 `canvas.sync` | 我们的状态在客户端，Agent 无法可靠读到“刚改完”的结果 |
| 流式事件 | SSE + 统一 RunEvent（run/step/tool/artifact/message） | WebSocket/事件流 + stream adapter，工具产物单独提取 | 我们的事件契约够用，缺少思考/子任务事件 |
| 持久化 | 项目在 Supabase；消息、画布、文件在内存 | 消息、画布、文件、作业、checkpoint 全部 Supabase | 这是“每次感觉不一样”的最大来源 |
| 可观测性 | console + SSE 事件 | 结构化日志 + 单测；没接 LangSmith | 我们调提示词只能靠截图和手测 |

## 2. 能力矩阵

| 能力 | my-lovart | Lavart | 差距判断 |
|---|---|---|---|
| 图片生成 | Seedream 5.0 Lite，固定 provider；prompt/aspectRatio/inputImages | 多 provider（Volces/Google/OpenAI/Replicate），模型、质量、格式、画幅、画布位置都可选 | 我们够用，但不可切换、不可重试 |
| 视频生成 | MiniMax H3，固定 provider；时长 4-15s | 多 provider（Metaso/Google/Replicate），分辨率、音频、首尾帧、视频改视频 | 视频链路明显更薄，播放问题也在这层 |
| 图生图 | 支持 inputImages（asset_id / URL / data URL） | 支持，并有视觉输入与附件压缩 | 我们刚补上“模型真的能看到图” |
| 画布读取 | 摘要：id/别名/类型/名称/位置/尺寸 | summary/full、按 element_id、按类型、按区域筛选 | 我们够基本排版，复杂查询不足 |
| 画布操作 | move/resize/delete/align/distribute/reorder/opacity/arrange | 上述 + add_text/add_shape/add_line/update_style/update_text + 绑定/级联/写锁 | 我们不能新建文字形状，设计任务上限低 |
| 需求确认 | 自研 `offer_choices`：信息少用 Markdown，只差一个离散项出 1-3 个答案按钮 | 提示词没有这套；靠模型自然追问 | 这是我们的产品差异，不是缺陷 |
| 视觉输入 | 最近 4 张图作为 `image_url` 内容块 | `prepareVisionAttachments`：sharp 压缩、尺寸/大小校验 | 我们能用，但没有压缩和预算 |
| 对话记忆 | 文本历史重放 + 最近附件重注入 | checkpointer thread_id | 我们会遗忘工具细节、旧附件；Lavart 不会 |
| 作业/重试 | 无，同步 tool call | PGMQ + worker + 状态表 + 重试/取消 | 我们无法可靠处理慢视频和超时 |
| 项目检索 | 无 | `project_search` 搜项目素材 | 多素材项目里我们会瞎找 |
| 沙箱/文件 | 无 | deepagents 文件系统 + execute | 不做代码/批量处理时可不补 |
| 品牌/技能 | 明确不做 | brand kit + skills | 按你的范围，不需要 |
| 测试/CI | 无 | 单测覆盖 vision/job/video/canvas | 我们没有回归网，改一处怕碰另一处 |
| LangSmith | 未接 | 未接 | 都不是记忆方案；先不急 |

## 3. 提示词对比

Lavart 主提示词约 60 行，按「画布感知 / 任务完成 / 工具选择 / 参考图片 / 模型偏好 / manipulate_canvas 操作表 / 强制规则 / 错误处理 / 坐标颜色字号」组织。它的特点：

- 画布只是一句背景：「你已经知道画布上有什么，直接基于这些信息行动」；
- 工具能力写成操作表和强制规则，不靠模型猜；
- 有明确的「任务完成就停止调用工具」；
- 参考图、模型偏好、品牌资产分别有段落；
- 不解释“什么时候该追问”，因为它的产品默认由模型自行推进。

我们现在的提示词已经按同样结构重写，但仍有三个真实差距：

1. **工具手册不够深**：Lavart 把 manipulate 的每个 action、绑定规则、坐标方向、颜色字号写进 prompt；我们主要靠 tool schema 的字段说明，模型容易少用 add_text/绑定这类能力（我们目前也还没有这些 action）。
2. **上下文说明依赖补丁**：我们写“最近几轮附件仍可用”，是因为没有 checkpointer；Lavart 不需要解释，线程状态里本来就有。
3. **产品策略不同**：Lavart 不强调追问按钮；我们的 `offer_choices` 是额外产品能力，提示词必须同时约束“什么时候问、什么时候停”，这部分复杂度是我们自己引入的，需要用测试固定，而不是继续加句子。

结论：提示词现在不是最大瓶颈，继续在 prompt 里加规则只会让模型更机械。下一步该补的是状态和工具。

## 4. 工具集差异明细

### 我们已有

- `generate_image`：Seedream，同步，产出 artifact + 自动入画布
- `generate_video`：MiniMax，同步，产出视频消息卡片
- `inspect_canvas`：只读摘要
- `manipulate_canvas`：移动/缩放/删除/对齐/分布/层级/透明度/整理
- `offer_choices`：把候选答案变成追问按钮

### Lavart 额外有

- `generate_image` 的多模型/质量/格式/placement 参数
- `generate_video` 的分辨率/音频/视频改视频/多模型
- `manipulate_canvas` 的 add_text / add_shape / add_line / update_style / update_text，以及绑定、级联删除、写锁
- `inspect_canvas` 的 full / element_id / filter_type / filter_region
- `project_search` 搜项目素材
- `persist_sandbox_file` 把沙箱产物落库
- deepagents 内置 `ls/read_file/write_file/edit_file/glob/grep/execute/task/write_todos`
- 视频子 Agent

我们不一定要全抄，但 `add_text/add_shape/update_text`、`inspect_canvas` 筛选、`project_search` 是设计任务真正会用到的。

## 5. 为什么总在反复改

1. **没有行为契约**：什么算“信息够”、什么时候必须停、按钮代表什么，只存在于对话里，没有一份可执行的规范。
2. **没有回归测试**：每次改 prompt/UI 都靠你截图验收；修 A 可能碰坏 B。
3. **状态在内存**：服务重启、刷新、换个入口，行为就可能不同；这会制造大量“上次还好好的”问题。
4. **没有线程记忆**：附件、工具调用、生成结果跨轮丢失，只能靠补丁重注入。
5. **生成是同步的**：视频这类慢任务没有作业层，超时/失败/重试都挤在 Agent 循环里。
6. **工具深度不够**：用户提出“加文字/改样式/并排/找素材”，我们只能临时加命令或让用户手工做。
7. **UI 暴露了 Agent 参数**：画幅下拉就是典型——UI 以为是用户参数，实际是工具参数，最后又得删。
8. **没有 trace/评测**：无法知道模型为什么这么答，只能复述截图。

## 6. 建议的收敛顺序

### Phase 0：先冻结，不再逐条打补丁

写一份《对话行为契约》+ 12 条 golden 场景，固定预期：

- 打招呼不汇报画布
- 空画布说做视频：Markdown 三问，不生成
- 只差一个离散项：1-3 个答案按钮
- 有附件问“这是谁”：基于画面回答
- 附件后一轮说“加点元素”：沿用参考图
- 视频信息不全：不调用 generate_video
- 画布并排/删除/整理：正确下发命令
- 失败/取消/重试/刷新：状态一致

这些场景不过，不改 UI、不调 prompt。

### Phase 1：持久化线程（最高优先）

- `chat_messages` / `canvases` / 文件落 Supabase
- 附件 asset_id 改成稳定 id（内容 hash 或附件表 id）
- 接 PostgresSaver checkpointer + `thread_id`
- 视觉附件做压缩和大小预算

这一步解决“遗忘、刷新后不一样、旧消息图片 404”。

### Phase 2：生成作业化

- `background_jobs` 表 + worker + 队列（PGMQ 或先用 Supabase 表轮询）
- 图片/视频工具改成提交作业、等待结果，支持超时、重试、取消
- 结果统一落 Storage，画布插入由服务端 placement 或命令完成
- 视频播放/编码问题在这一层一起修

### Phase 3：工具补齐

- `manipulate_canvas` 增加 add_text/add_shape/add_line/update_style/update_text
- `inspect_canvas` 增加 element_id / filter_type / filter_region
- 视需要增加 `project_search`

### Phase 4：UI 收敛

- 输入框保持只有 + 和发送
- 工具卡片按工具类型展示，产物与文字交错（已做）
- 模型偏好等入口等真正需要再加

### Phase 5：可观测与评测

- 结构化 trace（runId/threadId/toolCallId/耗时/错误码）
- 自动跑 golden 场景
- LangSmith 可选，等需要系统调 prompt/工具时再接

## 7. 不该做的事

- 不再为了单个截图往 prompt 里追加“不要……”；
- 不在 UI 里继续暴露 Agent 内部参数；
- 不先接 skills/品牌/计费；
- 不把 LangSmith 当记忆方案；
- 不追求把 Lavart 全抄一遍，只对齐生成闭环、画布工具、持久化、作业这四块。

## 8. 下一步建议

先做 Phase 0 + Phase 1。它们是“止血”：把行为预期固定下来，把线程状态落到数据库。完成后再看工具和视频，才不会每改一处又冒一处。