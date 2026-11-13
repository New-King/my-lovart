import cors from "@fastify/cors";
import Fastify from "fastify";
import { APP_NAME } from "@my-lovart/shared";
import { env } from "./lib/env.js";
import { UnauthorizedError } from "./lib/auth.js";
import { registerProjectRoutes } from "./http/projects.js";
import { registerWorkspaceRoutes } from "./http/workspace.js";
import {
  createMemoryProjectsRepository,
  createSupabaseProjectsRepository,
} from "./features/projects/projects.repository.js";

export function buildApp() {
  // 画布图片以 data URL 随 elements 一起提交，放宽默认 1MB 限制
  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });

  app.register(cors, { origin: env.webOrigins });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UnauthorizedError) {
      return reply.code(401).send({ error: error.message });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "服务器错误" });
  });

  app.get("/health", async () => ({
    ok: true,
    name: APP_NAME,
    store: env.projectsStore,
    agent: env.agentMode,
    uptime: Math.round(process.uptime()),
  }));

  const repo =
    env.projectsStore === "supabase" ? createSupabaseProjectsRepository() : createMemoryProjectsRepository();

  if (env.projectsStore === "memory") {
    app.log.warn("PROJECTS_STORE=memory：数据存在进程内存里，重启即清空");
  }

  if (env.agentMode === "mock") {
    app.log.warn("AGENT_MODE=mock：返回固定的图片/视频/灵感示例");
  }

  registerProjectRoutes(app, repo);
  registerWorkspaceRoutes(app);

  return app;
}