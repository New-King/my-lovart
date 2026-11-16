-- 0012 · 视频实际末帧
-- 下一镜承接上一镜视频的实际最后一帧，而不是另一张生成的尾帧图。

alter table public.storyboard_shots
  add column if not exists video_last_frame_asset_id uuid
  references public.project_assets (id) on delete set null;

alter table public.storyboard_shots enable row level security;