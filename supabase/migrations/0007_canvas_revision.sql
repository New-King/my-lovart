-- 画布乐观锁：前端自动保存必须带上自己看到的 revision，
-- 服务端生成作业插入图片也会递增 revision。旧场景不会覆盖新生成的图。
alter table canvases add column if not exists revision bigint not null default 0;