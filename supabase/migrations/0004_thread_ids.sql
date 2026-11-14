-- 0004 · Agent thread 绑定
-- 每个会话一个 LangGraph thread_id；checkpointer 用它恢复工具调用与消息。

alter table public.sessions
  add column if not exists thread_id text;

create unique index if not exists sessions_thread_id_idx
  on public.sessions (thread_id)
  where thread_id is not null;