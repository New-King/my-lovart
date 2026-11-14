-- 0005 · 异步生成作业
-- 表即队列：worker 用 claim_background_job() 原子领取，避免多进程重复执行。

create table if not exists public.background_jobs (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  session_id      uuid references public.sessions (id) on delete set null,
  thread_id       text,
  job_type        text not null check (job_type in ('image_generation', 'video_generation')),
  status          text not null default 'queued'
                  check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  payload         jsonb not null default '{}'::jsonb,
  result          jsonb,
  error_code      text,
  error_message   text,
  attempt_count   int not null default 0,
  max_attempts    int not null default 3,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  failed_at       timestamptz,
  canceled_at     timestamptz
);

create index if not exists background_jobs_queue_idx
  on public.background_jobs (status, created_at)
  where status = 'queued';

create index if not exists background_jobs_project_idx
  on public.background_jobs (project_id, created_at desc);

alter table public.background_jobs enable row level security;

create policy background_jobs_owner on public.background_jobs
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

-- 原子领取：多 worker 并发时不会拿到同一条
create or replace function public.claim_background_job()
returns setof public.background_jobs
language sql
security definer
set search_path = public
as $$
  with next_job as (
    select id
    from public.background_jobs
    where status = 'queued'
    order by created_at
    limit 1
    for update skip locked
  )
  update public.background_jobs jobs
  set status = 'running',
      started_at = now(),
      attempt_count = jobs.attempt_count + 1
  from next_job
  where jobs.id = next_job.id
  returning jobs.*;
$$;

revoke all on function public.claim_background_job() from public;
grant execute on function public.claim_background_job() to service_role;