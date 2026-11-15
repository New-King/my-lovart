-- 0009 · 分镜与镜头（Phase 2.5）
-- 分镜是结构化状态：可查询、可重置、可回退；资产账本保持不可变。

create table if not exists public.storyboards (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  title           text not null,
  brief           text not null default '',
  aspect_ratio    text,
  style           text,
  status          text not null default 'draft'
                  check (status in ('draft', 'ready', 'generating', 'completed')),
  active          boolean not null default true,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists storyboards_project_idx
  on public.storyboards (project_id, created_at desc);

create table if not exists public.storyboard_shots (
  id               uuid primary key default gen_random_uuid(),
  storyboard_id    uuid not null references public.storyboards (id) on delete cascade,
  order_index      int not null,
  title            text not null,
  description      text not null default '',
  prompt           text not null default '',
  duration_seconds numeric,
  camera           text,
  transition       text,
  active_asset_id  uuid,
  status           text not null default 'draft'
                   check (status in ('draft', 'generating', 'ready', 'failed')),
  metadata         jsonb not null default '{}'::jsonb,
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (storyboard_id, order_index)
);

create index if not exists storyboard_shots_board_idx
  on public.storyboard_shots (storyboard_id, order_index);

create table if not exists public.storyboard_revisions (
  id             uuid primary key default gen_random_uuid(),
  storyboard_id  uuid not null references public.storyboards (id) on delete cascade,
  reason         text not null,          -- create / update_shot / reorder / reset / restore
  snapshot       jsonb not null,         -- 整个 storyboard + shots 的 JSON
  created_at     timestamptz not null default now()
);

create index if not exists storyboard_revisions_board_idx
  on public.storyboard_revisions (storyboard_id, created_at desc);

-- project_assets.shot_id 在 0003 预留，这里补外键；旧数据有孤儿时回退为 null 会失败，
-- 因此只在外键不存在时添加。
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'project_assets_shot_id_fkey'
  ) then
    alter table public.project_assets
      add constraint project_assets_shot_id_fkey
      foreign key (shot_id) references public.storyboard_shots (id) on delete set null;
  end if;
end $$;

-- 镜头当前版本资产；资产删除时只清空指针，不删镜头
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'storyboard_shots_active_asset_id_fkey'
  ) then
    alter table public.storyboard_shots
      add constraint storyboard_shots_active_asset_id_fkey
      foreign key (active_asset_id) references public.project_assets (id) on delete set null;
  end if;
end $$;

alter table public.storyboards enable row level security;
alter table public.storyboard_shots enable row level security;
alter table public.storyboard_revisions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'storyboards' and policyname = 'storyboards_owner') then
    create policy storyboards_owner on public.storyboards
      for all using (
        exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
      ) with check (
        exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
      );
  end if;
  if not exists (select 1 from pg_policies where tablename = 'storyboard_shots' and policyname = 'storyboard_shots_owner') then
    create policy storyboard_shots_owner on public.storyboard_shots
      for all using (
        exists (
          select 1 from public.storyboards s
          join public.projects p on p.id = s.project_id
          where s.id = storyboard_id and p.user_id = auth.uid()
        )
      ) with check (
        exists (
          select 1 from public.storyboards s
          join public.projects p on p.id = s.project_id
          where s.id = storyboard_id and p.user_id = auth.uid()
        )
      );
  end if;
  if not exists (select 1 from pg_policies where tablename = 'storyboard_revisions' and policyname = 'storyboard_revisions_owner') then
    create policy storyboard_revisions_owner on public.storyboard_revisions
      for all using (
        exists (
          select 1 from public.storyboards s
          join public.projects p on p.id = s.project_id
          where s.id = storyboard_id and p.user_id = auth.uid()
        )
      ) with check (
        exists (
          select 1 from public.storyboards s
          join public.projects p on p.id = s.project_id
          where s.id = storyboard_id and p.user_id = auth.uid()
        )
      );
  end if;
end $$;