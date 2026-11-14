# M14 · 附件“没收到图片”排查与加固

## 现象

用户在同一条消息里附了图并问「你知道这是谁吗」，助手回答「画布是空的，我这轮也没收到任何图片」。
这不是预期行为：附件在消息里、画布为空都不影响读图。

## 定位

先查了真实数据（Supabase `messages`），不是猜：

- 用户消息“你知道这是谁吗”的 `attachments[0]` 是
  `{ name: "楪祈", mimeType: "image/jpeg", url: "blob:http://localhost:3000/733034bb-…", size: 0 }`
- 对应助手消息说“没收到任何图片”

根因：素材库 `uploadMaterial` 用了 `URL.createObjectURL(file)`。`blob:` 只在当前页面进程有效，
服务端既存不下也读不到；旧代码把它当普通远端 URL 收下，模型侧解析失败后被静默跳过，
于是模型真的只看到一句“你知道这是谁吗”。

复现时又用真实链路跑了一遍：

1. 造一张写着 `HELLO 2026` 的 JPEG；
2. 用 service_role 走 Supabase 魔法链接拿真实 JWT；
3. `POST /projects` 建临时项目；
4. `POST /workspace/:id/messages`，body 带 `attachments`（data URL）；
5. 解析 SSE，看模型回答。

结果：HTTP 200，附件日志 `raw=1 accepted=1`，模型回答 `HELLO 2026`。
说明 data URL 链路本身是通的，问题只在素材库产出的 blob 地址。

## 修复

- 前端素材库改为 `FileReader.readAsDataURL`，上传即得到 data URL；删除素材只对 blob 地址 revoke。
- 发送前兜底：`chat-composer` 把任何仍在用的 `blob:` 附件转成 data URL 再提交。
- 服务端 `normalizeAttachment` 明确拒绝 `blob:` / `file:`，不再把它们当远端 URL 收下。
- `buildAttachmentContext` 对读不出来的图片保留 `<image status="unavailable">`，
  并提示模型让用户重传，禁止回答“没收到图片”。
- 消息路由：`raw > 0 && accepted === 0` 返回 400 并写一条 rejection trace，
  不再静默降级成纯文本。

## 验证

```bash
pnpm --filter @my-lovart/server verify:attachments
```

覆盖：data URL 被接受、地址变成 /files、MIME 保留、`<input_images>` 生成、损坏附件标记 unavailable、
非图片附件不进入视觉上下文、`blob:` 被拒绝。9 项全部 PASS。

另外做了真实 HTTP 端到端（真实 JWT / 真实 Supabase / 真实模型），临时项目与 Storage 文件已清理。

## 运行 trace

每次运行都会在仓库根目录 `.traces/` 写一个 JSONL，包含：

- 请求侧原始附件数量与每个附件的地址种类（data / local-file / blob / remote）
- 归一化后的附件、`/files` 地址、MIME
- Agent 实际拿到的视觉图数量、`<input_images>` XML
- 发给模型的 userText 与历史条数
- 工具调用参数/结果、最终回答、错误堆栈

查看最近一次：

```bash
pnpm --filter @my-lovart/server trace:latest
```

`GET /health` 也会返回 `pid / startedAt / traceDir`，可以确认当前请求到底打到了哪个进程。

## 提醒

`pnpm start` 不带 watch，改完服务端代码必须重启；`pnpm dev` 才会自动重载。