-- 0013 · 产品细节/状态锚图
-- 开盖、螺纹、内胆、倒水等状态不能从闭盖实拍里猜；需要单独的真实细节参考。

alter table public.storyboards
  add column if not exists product_detail_anchor_asset_id uuid
  references public.project_assets (id) on delete set null;

alter table public.storyboards enable row level security;