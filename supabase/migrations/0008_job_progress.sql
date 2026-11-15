-- 0008 · 作业进度
-- worker 把 provider 的排队/渲染/下载阶段写回队列；工具等待时映射到工具卡片。
alter table background_jobs add column if not exists progress int not null default 0;
alter table background_jobs add column if not exists stage text;