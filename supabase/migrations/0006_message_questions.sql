-- 0006 · 结构化追问
-- 一条助手消息可以带 1-3 个问题，每个问题有 2-4 个候选答案；前端逐题渲染。

alter table public.messages
  add column if not exists questions jsonb not null default '[]'::jsonb;