-- 0011 · 视频连贯性：多锚点、镜头执行字段、首尾帧衔接
-- canon_asset_id 作为产品锚；新增角色/场景/主视觉锚，全部作为关键帧执行参考。

alter table public.storyboards
  add column if not exists character_anchor_asset_id uuid references public.project_assets (id) on delete set null;
alter table public.storyboards
  add column if not exists scene_anchor_asset_id uuid references public.project_assets (id) on delete set null;
alter table public.storyboards
  add column if not exists style_anchor_asset_id uuid references public.project_assets (id) on delete set null;

alter table public.storyboard_shots
  add column if not exists scene_goal text not null default '';
alter table public.storyboard_shots
  add column if not exists continuity_note text not null default '';
alter table public.storyboard_shots
  add column if not exists negative_prompt text not null default '';

alter table public.storyboards enable row level security;
alter table public.storyboard_shots enable row level security;