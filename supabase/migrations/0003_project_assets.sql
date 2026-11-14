-- 0003 · 项目产物账本
-- 一行代表一次生成/上传产生的具体文件；不可变，不覆盖。
-- 分镜表在 0004 增加，本迁移只预留 shot_id。

create table if not exists public.project_assets (
  id               uuid primary key,
  project_id       uuid not null references public.projects (id) on delete cascade,
  kind             text not null check (kind in ('image', 'video')),
  origin           text not null default 'generated'
                   check (origin in ('generated', 'uploaded', 'derived')),
  title            text not null,
  prompt           text not null default '',
  model            text,
  provider         text,
  url              text not null,
  mime_type        text,
  width            integer,
  height           integer,
  duration_seconds numeric,
  aspect_ratio     text,
  parent_asset_id  uuid references public.project_assets (id) on delete set null,
  source_asset_ids jsonb not null default '[]'::jsonb,
  canvas_element_id text,
  message_id       uuid,
  shot_id          uuid,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists project_assets_project_created_idx
  on public.project_assets (project_id, created_at desc);

create index if not exists project_assets_shot_idx
  on public.project_assets (shot_id)
  where shot_id is not null;

alter table public.project_assets enable row level security;

create policy project_assets_owner on public.project_assets
  for all using (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid()
    )
  );