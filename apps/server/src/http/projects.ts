import type { FastifyInstance } from "fastify";
import { requireUserId } from "../lib/auth.js";
import { ProjectNameError, createProjectsService } from "../features/projects/projects.service.js";
import type { ProjectsRepository } from "../features/projects/projects.repository.js";

type Params = { id: string };
type Body = { name?: unknown };

export function registerProjectRoutes(app: FastifyInstance, repo: ProjectsRepository) {
  const service = createProjectsService(repo);
  app.get("/projects", async (request) => service.list(await requireUserId(request)));

  app.post<{ Body: Body }>("/projects", async (request, reply) => {
    try {
      const project = await service.create(await requireUserId(request), request.body?.name ?? "未命名项目");
      return reply.code(201).send(project);
    } catch (err) {
      if (err instanceof ProjectNameError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.patch<{ Params: Params; Body: Body }>("/projects/:id", async (request, reply) => {
    try {
      const project = await service.rename(await requireUserId(request), request.params.id, request.body?.name);
      if (!project) return reply.code(404).send({ error: "项目不存在" });
      return project;
    } catch (err) {
      if (err instanceof ProjectNameError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /** 首次产生内容时根据 prompt 自动命名；已经手动改过名的会原样返回 */
  app.post<{ Params: Params; Body: { prompt?: unknown } }>(
    "/projects/:id/auto-name",
    async (request, reply) => {
      const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
      if (!prompt) return reply.code(400).send({ error: "缺少 prompt" });
      const project = await service.autoName(
        await requireUserId(request),
        request.params.id,
        prompt,
      );
      if (!project) return reply.code(404).send({ error: "项目不存在" });
      return project;
    },
  );

  app.delete<{ Params: Params }>("/projects/:id", async (request, reply) => {
    const ok = await service.remove(await requireUserId(request), request.params.id);
    if (!ok) return reply.code(404).send({ error: "项目不存在" });
    return reply.code(204).send();
  });
}