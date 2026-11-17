-- 0014 · 用户素材库
-- 素材按用户存，不按项目存：同一个人在不同项目里都能复用上传的参考图。
-- 文件本体走 project-files Storage（attachments/<file_id>），这里只存引用与展示信息。

create table if not exists public.user_materials (
  id          uuid primary key,
  user_id     uuid not null,
  name        text not null check (char_length(name) between 1 and 120),
  url         text not null,
  file_id     uuid not null,
  mime_type   text not null,
  size_bytes  bigint not null default 0,
  width       integer,
  height      integer,
  created_at  timestamptz not null default now()
);

create index if not exists user_materials_user_created_idx
  on public.user_materials (user_id, created_at desc);

alter table public.user_materials enable row level security;

drop policy if exists user_materials_owner on public.user_materials;
create policy user_materials_owner on public.user_materials
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);