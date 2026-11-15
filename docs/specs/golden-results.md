# Golden 场景基线结果

日期：2026-11-15
说明：记录到 Phase 2a（作业化 / 服务端画布写入 / 逐题提问卡）。通过项来自真实模型手测；未跑项在后续阶段补。

| 场景 | 状态 | 备注 |
|---|---|---|
| G01 空画布打招呼 | 通过 | 正常打招呼，未提画布为空，无工具 |
| G02 空画布做视频 | 通过 | Markdown 三问，无按钮、无视频工具 |
| G03 视频只答一半 | 通过 | 只答 5 秒 + 品牌后，继续问画幅和内容/调性，未生成 |
| G04 只差一个离散项 | 通过 | 一问 + 三个投放场景按钮（offer_choices） |
| G05 图片附件识别 | 通过 | 测试图 HELLO 2026 被正确读出；不再是只读文件名。另做真实 HTTP 端到端：真实 JWT + data URL 附件 + 真实模型，回答正确（见 `docs/notes/M14-attachment-e2e.md`） |
| G06 跨轮沿用参考图 | 通过 | 无当前附件仍调用 generate_image 做图生图 |
| G07 空画布声称有图 | 通过 | 明确说画布为空、未拿到图片，让用户上传 |
| G08 画布并排 | 通过 | 只调 manipulate_canvas，下发 align + move |
| G09 画布删除 | 未跑 | Phase 1 补 |
| G10 多版本交错 | 部分 | 渲染链路已单测 parts 顺序；未跑完整双图真实生成 |
| G11 工具失败 | 部分 | 失败卡片与错误透传已有；未做统一场景 |
| G12 用户取消 | 部分 | 取消事件已有；未跑视频中途取消 |
| G13 刷新恢复 | 通过（Phase 1a/1b/1d） | 消息、画布、Excalidraw files、聊天附件均落 Supabase/Storage；checkpointer 跨进程恢复 thread，杀进程后第三轮仍答出 ORBIT-9（`docs/notes/M16.md`） |
| G14 画布缩放 | 通过 | 实测只调 manipulate_canvas resize |
| G15 纯文字任务 | 通过 | 不调用视觉工具 |
| G16 跨轮引用已生成图片 | 部分（Phase 1c） | 资产账本与 `<project_assets>` 已通：预置资产问标题，真实模型答对；完整“画布删图后改图”还需一次真实生成手测 |
| G17 修改第 3 个镜头 | 通过（Phase 2.5） | 真实模型：第 3 镜头机位改为俯拍，`get_storyboard` + `update_shot`；只改目标镜头。另给第 1 镜头真实生成 3:4 参考图，shot active/asset.shot_id/画布一致 |
| G18 重置分镜 | 通过（Phase 2.5） | 第一轮说明影响并等确认；确认后清空 active、状态 draft，旧资产仍保留，revisions 增加 reset |
| G19 版本回退 | 通过（Phase 2.5） | “用回第二版” → `get_storyboard` + `set_shot_asset`，active 切到 v2，v1 保留，不重新生成 |
| G20 两个分镜并存 | 通过（Phase 2.5） | 项目两个分镜，问“产品开箱第 2 镜头”答对；新建分镜自动成为唯一 active |
| G21 资产很多时的上下文预算 | 未跑 | 已有 `<project_assets>` 摘要 + `list_assets`，未构造 40 资产场景 |
| G23 生成失败保留状态 | 未跑 | 依赖一次失败生成；设计上 worker 失败不写 active，旧版本保留 |
| G22 无分镜无资产 | 通过（Phase 1c） | 空项目不注入 `<project_state>` / `<project_assets>`，不主动汇报空状态 |
| G24 逐题提问卡 | 通过（后端+回答闭环，Phase 2a） | 真实模型：一句承接 + 3 题结构化问题，`messages.questions` 落库；按卡片格式回答后直接出图（Seedream 30.6s），资产与画布 `assetId` 一致。UI 未在真实浏览器点测（见 `docs/notes/M18.md`） |
| G25 checkpoint 写失败 | 代码通过，未故障注入 | 重试 + 降级完成 + thread 轮换已实现（`docs/notes/M19.md`）；真实正常轮验证 checkpointer 可用，超时路径待注入测试 |
| G26 服务端插画布可见 | 通过（Phase 2a/2b） | 多进程 worker 抢作业后：DB revision 1/1 元素，修复前 HTTP 返回 0/0，修复后返回 1/1；下一轮模型能答出画布上的图；旧 revision 保存返回 409 |
| G27 accepted 前反馈 | 代码通过，未浏览器点测 | 本地 shimmer 行 + streaming 零记录也渲染 + 全工具行已实现；布局/动效需用户页面确认 |
| G28 视频落画布 | 通过（插入链路，未真机播放） | 临时项目 `insertVideoOnCanvas`：embeddable 元素、revision=1、isVideo/link/duration 正确；上下文识别为 1 条视频；播放器 UI 待用户验证（`docs/notes/M20.md`） |
| G29 进度与取消 | 部分（进度通过，取消未真测） | 模拟 running job：progress/stage 回调、succeeded/100 通过；worker 取消 abort 已实现，真实视频取消按约定留给用户测 |

| G30 视频前期闸门 | 通过（6/6，脚本验收） | 无 shotId、本轮新建镜头、缺首帧、本轮新首帧均被拦；上轮脚本+首帧放行；`direct=true` 显式跳过。不调用视频服务（`docs/notes/M22.md`） |

| G31 视频前期一致性 | 通过（17/17，脚本验收） | 锚图组 + 关键帧血缘 + 5 秒 1 镜头/10 秒最多 2 镜头；无产品锚/无血缘首帧/5 秒 4 镜头均被拒（`docs/notes/M23.md`） |
| G32 多镜头连贯性 | 通过（17/17，脚本验收） | 首镜缺尾帧拒绝；下一镜首帧自动引用上一镜尾帧；没承接尾帧的首帧 `continuity_not_anchored`；两镜首尾接通后放行（`docs/notes/M24.md`） |

## 当前失败/缺口

1. G10/G11/G12 需要自动化或可重复手测脚本，避免每次靠人工。
2. G16 的“真实生成→删图→改图”闭环未跑；G17–G21、G23 依赖分镜（Phase 2.5）。
3. G09 补一次真实画布删除测试。
4. 视频画布元素/内联播放、worker 进度映射、真实超时/取消验证仍是 P0 缺口（Phase 2b）。
5. G24 的卡片交互（逐题勾选、自动滚动、跳过/提交）还没有浏览器自动化；目前只有布局预览和发送格式的端到端验证。
6. G25 的 checkpoint 写失败没有做故障注入；G27 的 shimmer/展开效果需要在真实页面点测。
7. G28 的视频播放器与 G29 的真实取消没有做视频生成手测（按用户要求停在最终 generate_video 前）。
8. G21 的 40 资产预算场景、G23 的失败生成保留状态还没构造；分镜 UI 也还没有。
9. 多镜头视频拼接成片尚未实现：每个镜头只生成独立 clip，10 秒 2 镜头需要合成后才是成片；用户已明确暂不优先。

## 下一步

Phase 2b：视频画布元素与内联播放；把 worker 进度映射到工具卡片；构造一次真实超时/取消验证。随后 Phase 2.5 分镜。