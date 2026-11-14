-- 0002_workspace_persistence.sql
-- 把对话消息与画布从进程内存搬到 Supabase。
-- 说明：0001 里已经有 projects / canvases / sessions / messages 四张表，
-- 这里只补运行态字段，不改变原有层级。

-- 一个项目只保留一个主画布 / 一个主会话；重复数据需要先人工清理再执行。
create unique index if not exists canvases_project_unique
  on public.canvases (project_id);

create unique index if not exists sessions_project_unique
  on public.sessions (project_id);

alter table public.canvases
  add column if not exists files jsonb not null default '{}'::jsonb;

alter table public.messages
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists parts jsonb not null default '[]'::jsonb,
  add column if not exists steps jsonb not null default '[]'::jsonb,
  add column if not exists thoughts jsonb not null default '[]'::jsonb,
  add column if not exists options jsonb not null default '[]'::jsonb,
  add column if not exists status text not null default 'completed',
  add column if not exists error text,
  add column if not exists failure jsonb,
  add column if not exists updated_at timestamptz not null default now();

alter table public.messages
  drop constraint if exists messages_status_check;

alter table public.messages
  add constraint messages_status_check
  check (status in ('queued', 'streaming', 'completed', 'canceled', 'failed'));

create index if not exists messages_session_updated_idx
  on public.messages (session_id, updated_at desc);

drop trigger if exists messages_touch on public.messages;
create trigger messages_touch before update on public.messages
  for each row execute function public.touch_updated_at();

drop trigger if exists canvases_touch on public.canvases;
create trigger canvases_touch before update on public.canvases
  for each row execute function public.touch_updated_at();