# M14 · 附件“没收到图片”排查与加固

## 现象

用户在同一条消息里附了图并问「你知道这是谁吗」，助手回答「画布是空的，我这轮也没收到任何图片」。
这不是预期行为：附件在消息里、画布为空都不影响读图。

## 定位

用真实链路复现，而不是继续猜：

1. 造一张写着 `HELLO 2026` 的 JPEG；
2. 用 service_role 走 Supabase 魔法链接拿真实 JWT；
3. `POST /projects` 建临时项目；
4. `POST /workspace/:id/messages`，body 带 `attachments`（data URL）；
5. 解析 SSE，看模型回答。

结果：HTTP 200，附件日志 `raw=1 accepted=1`，模型回答 `HELLO 2026`。
说明当前代码的「前端附件 → 服务端归一化 → /files → data URL → image_url 视觉输入」是通的。
截图对应的进程要么是改动前启动、没有重启的旧服务，要么命中了下面这个静默降级路径。

## 加固

- `buildAttachmentContext` 不再把读不出来的图片直接跳过：保留 `<image status="unavailable">`，
  并在 `<vision_note>` 里明确「用户确实传了图，但文件没读出来，请让用户重传」，禁止回答「没收到图片」。
- `resolveReference` 修正：本地 `/files/*` 下载失败时不再把 URL 原样交给模型（供应商访问不到 127.0.0.1），
  现在会返回 undefined 并走 unavailable；远端公开 URL 仍原样透传。
- 消息路由：`raw > 0 && accepted === 0` 直接返回 400「图片附件读取失败，请重新上传」，
  不再静默降级成纯文本；同时记录 `raw / accepted` 日志，下次一眼能看出是前端没发、还是服务端没收下。

## 验证

```bash
pnpm --filter @my-lovart/server verify:attachments
```

覆盖：data URL 被接受、地址变成 /files、MIME 保留、`<input_images>` 生成、损坏附件标记 unavailable、
非图片附件不进入视觉上下文。8 项全部 PASS。

另外做了真实 HTTP 端到端（真实 JWT / 真实 Supabase / 真实模型），临时项目与 Storage 文件已清理。

## 提醒

`pnpm start` 不带 watch，改完服务端代码必须重启；`pnpm dev` 才会自动重载。