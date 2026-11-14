import cors from "@fastify/cors";
import Fastify from "fastify";
import { APP_NAME } from "@my-lovart/shared";
import { env } from "./lib/env.js";
import { UnauthorizedError } from "./lib/auth.js";
import { registerProjectRoutes } from "./http/projects.js";
import { registerWorkspaceRoutes } from "./http/workspace.js";
import { registerFileRoutes } from "./http/files.js";
import {
  createMemoryProjectsRepository,
  createSupabaseProjectsRepository,
} from "./features/projects/projects.repository.js";

export function buildApp() {
  // 附件以 base64 随消息上传，几张图就可能超过 1MB，放宽到 64MB
  const app = Fastify({ logger: true, bodyLimit: 64 * 1024 * 1024 });

  app.register(cors, { origin: env.webOrigins });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UnauthorizedError) {
      return reply.code(401).send({ error: error.message });
    }
    // Fastify 自己抛的 4xx（例如空 body 的 JSON 请求、格式错误）如实返回，别一律包成 500
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.code(status).send({ error: error instanceof Error ? error.message : "请求格式错误" });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "服务器错误" });
  });

  app.get("/health", async () => ({
    ok: true,
    name: APP_NAME,
    store: env.projectsStore,
    generation: env.generationMode,
    uptime: Math.round(process.uptime()),
  }));

  const repo =
    env.projectsStore === "supabase" ? createSupabaseProjectsRepository() : createMemoryProjectsRepository();

  if (env.projectsStore === "memory") {
    app.log.warn("PROJECTS_STORE=memory：数据存在进程内存里，重启即清空");
  }

  if (env.generationMode === "mock") {
    app.log.warn("GENERATION_MODE=mock：返回固定的图片/视频/灵感示例");
  }

  registerProjectRoutes(app, repo);
  registerWorkspaceRoutes(app, repo);
  registerFileRoutes(app);

  return app;
}