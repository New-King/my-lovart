-- 0010 · 视频前期：设定图、关键帧与成片指针（Phase 3a）
-- 解决：每个镜头各自文生图导致产品不一致；图片/视频共用 active_asset_id 导致角色混淆。

alter table public.storyboards
  add column if not exists kind text not null default 'image'
  check (kind in ('image', 'video'));
alter table public.storyboards
  add column if not exists canon_asset_id uuid references public.project_assets (id) on delete set null;
alter table public.storyboards
  add column if not exists total_duration_seconds numeric;

alter table public.storyboard_shots
  add column if not exists first_frame_asset_id uuid references public.project_assets (id) on delete set null;
alter table public.storyboard_shots
  add column if not exists end_frame_asset_id uuid references public.project_assets (id) on delete set null;
alter table public.storyboard_shots
  add column if not exists video_asset_id uuid references public.project_assets (id) on delete set null;

-- 旧数据：把原来的 current 资产按 kind 迁移到首帧/成片指针
update public.storyboard_shots s
set first_frame_asset_id = s.active_asset_id
where s.first_frame_asset_id is null
  and s.active_asset_id is not null
  and exists (
    select 1 from public.project_assets a
    where a.id = s.active_asset_id and a.kind = 'image'
  );

update public.storyboard_shots s
set video_asset_id = s.active_asset_id
where s.video_asset_id is null
  and s.active_asset_id is not null
  and exists (
    select 1 from public.project_assets a
    where a.id = s.active_asset_id and a.kind = 'video'
  );

alter table public.storyboards enable row level security;
alter table public.storyboard_shots enable row level security;