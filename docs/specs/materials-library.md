# 素材库（用户级）

> 状态：已接服务端、Supabase 表与 Storage；刷新/重启后仍在
> 最后更新：2026-11-17
> 关联：`supabase/migrations/0014_user_materials.sql`、`apps/server/src/features/materials/`、`apps/web/src/lib/materials-api.ts`

## 为什么按用户存

素材库是“我上传过的参考图”，不是某个项目的产物；同一账号在不同项目里都应该能复用。因此表是 `user_materials(user_id, ...)`，不挂 `project_id`。项目产物仍走 `project_assets`，两者不要混。

## 数据与文件

- 记录：`id / user_id / name / url / file_id / mime_type / size_bytes / width / height / created_at`
- 文件：`project-files` bucket 的 `attachments/<file_id>`；`/files/:id` 按 UUID 公开读取（和聊天附件同一条规则）
- 上传：客户端先用和聊天附件相同的预处理（长边 1600、超 10MB 重编码），把 data URL POST 给服务端；服务端转存后返回 `/files/:id`
- 删除：先删 DB 行，再删 Storage 对象；同时给 `file.store` 写删除墓碑，避免 Storage 最终一致期间把旧对象重新缓存回来

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/materials` | 当前用户的素材，按创建时间倒序 |
| POST | `/materials` | `{ name, mimeType, dataUrl, width?, height? }`，只接受 `data:image/*` |
| POST | `/materials/:id/delete` | 删除记录与文件；公共 mock 素材不调用 |

全部需要 `Authorization: Bearer <JWT>`；服务端用 service_role 查询，但每条都显式带 `user_id`，RLS 也按 `auth.uid() = user_id` 兜底。

## 前端

`MaterialLibraryPanel` 的“上传素材”不再写内存数组：

- 加载失败显示错误条 + 重试，不再静默变空；
- 上传/删除失败保留原列表并提示；
- 上传成功后插入列表；刷新页面重新 `GET /materials`，素材仍在。

公共素材（`PUBLIC_MATERIALS`）仍是本地只读 mock，和上传素材分开显示。

## 验收

`pnpm --filter @my-lovart/server verify:materials`（11/11，真实 Supabase + Storage + JWT）：

- 上传返回 201、URL 是 `/files/:id`、尺寸入库；
- 重新 GET 后仍能读到；
- Storage 里确实有对象（不是只在进程内存）；
- `/files/:id` 可读；
- 非图片被拒绝；
- 删除后列表消失、`/files/:id` 404、Storage 对象清理。

## 已知边界

- 单文件上限 12MB（服务端 `MAX_FILE_BYTES`）；客户端会先缩图，正常图片不会触顶；
- Storage 删除是最终一致的，删除后短时间内 CDN 可能还能下载旧对象，但新请求不会再缓存（墓碑）；
- 旧版本“内存素材”无法恢复，需要重新上传一次。