import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChatMessage, RunEvent } from "@my-lovart/shared";
import { env } from "../lib/env.js";
import { requireUserId } from "../lib/auth.js";
import { createTrace } from "../lib/trace.js";
import { LlmError } from "../lib/llm.js";
import { cancelJob, getJob } from "../features/jobs/jobs.js";
import {
  MESSAGE_MAX,
  WorkspaceInputError,
  createWorkspaceService,
  normalizeAspect,
  normalizeAttachments,
} from "../features/workspace/workspace.service.js";
import type { ProjectsRepository } from "../features/projects/projects.repository.js";

type Params = { projectId: string };

type MessageBody = { text?: unknown; attachments?: unknown; aspectRatio?: unknown };
type GenerateBody = {
  kind?: unknown;
  prompt?: unknown;
  aspectRatio?: unknown;
  attachments?: unknown;
};

function baseUrlFor(request: FastifyRequest): string {
  return `${request.protocol}://${request.headers.host ?? `127.0.0.1:${env.port}`}`;
}

/** trace 用：只保留附件类型和地址种类，不落 base64。 */
function summarizeRawAttachments(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).map((item) => {
    const value = (item ?? {}) as Record<string, unknown>;
    const url = typeof value.url === "string" ? value.url : "";
    return {
      name: value.name,
      mimeType: value.mimeType,
      size: value.size,
      urlKind: url.startsWith("data:")
        ? "data-url"
        : url.startsWith("blob:")
          ? "blob"
          : url.includes("/files/")
            ? "local-file"
            : url
              ? "remote-url"
              : "empty",
    };
  });
}

/**
 * 开一条 SSE：调用后 Fastify 不再接管响应，所有写入都走 raw。
 * 客户端断开（停止生成/关页面）时触发 close，由调用方取消任务。
 */
function openEventStream(request: FastifyRequest, reply: FastifyReply) {
  reply.hijack();
  const raw = reply.raw;

  const origin = request.headers.origin;
  const allowedOrigin =
    typeof origin === "string" && env.webOrigins.includes(origin)
      ? origin
      : (env.webOrigins[0] ?? "*");

  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": allowedOrigin,
    vary: "origin",
  });
  raw.flushHeaders?.();

  const heartbeat = setInterval(() => {
    if (!raw.destroyed && !raw.writableEnded) raw.write(": ping\n\n");
  }, 15_000);

  return {
    send(event: RunEvent): boolean {
      if (raw.destroyed || raw.writableEnded) return false;
      raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      return true;
    },
    close() {
      clearInterval(heartbeat);
      if (!raw.writableEnded) raw.end();
    },
  };
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  projects: ProjectsRepository,
) {
  const service = createWorkspaceService();

  /** workspace 走 service_role，必须自己校验项目归属 */
  async function ownProject(
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
  ): Promise<boolean> {
    const userId = await requireUserId(request);
    const project = await projects.find(userId, projectId);
    if (!project) {
      reply.code(404).send({ error: "项目不存在" });
      return false;
    }
    return true;
  }

  app.get<{ Params: Params }>("/workspace/:projectId", async (request, reply) => {
    if (!(await ownProject(request, reply, request.params.projectId))) return;
    return service.get(request.params.projectId);
  });

  app.post<{ Params: Params; Body: { elements?: unknown; files?: unknown } }>(
    "/workspace/:projectId/canvas",
    async (request, reply) => {
      if (!(await ownProject(request, reply, request.params.projectId))) return;
      try {
        await service.saveCanvas(
          request.params.projectId,
          request.body?.elements ?? [],
          request.body?.files,
        );
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof WorkspaceInputError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  /** 发送一条消息并开始一次运行，响应是 SSE。 */
  app.post<{ Params: Params; Body: MessageBody }>(
    "/workspace/:projectId/messages",
    async (request, reply) => {
      if (!(await ownProject(request, reply, request.params.projectId))) return;

      const projectId = request.params.projectId;
      const body = request.body ?? {};
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length > MESSAGE_MAX) {
        return reply.code(400).send({ error: "消息过长" });
      }

      const attachments = await normalizeAttachments(body.attachments, baseUrlFor(request));
      const rawAttachments = Array.isArray(body.attachments) ? body.attachments.length : 0;
      if (rawAttachments > 0) {
        request.log.info(
          { raw: rawAttachments, accepted: attachments.length },
          "message attachments",
        );
        // 宁可明确报错，也不要把一张读不出来的图静默降级成纯文本，
        // 否则用户看到的是「我没收到任何图片」。
        if (attachments.length === 0) {
          const trace = createTrace(`reject-${request.id}`, {
            projectId,
            requestId: request.id,
            rawAttachments: summarizeRawAttachments(body.attachments),
          });
          trace.event("attachments.rejected", { reason: "附件全部无法归一化" });
          return reply.code(400).send({ error: "图片附件读取失败，请重新上传" });
        }
      }
      if (!text && attachments.length === 0) {
        return reply.code(400).send({ error: "消息不能为空" });
      }
      const aspectRatio = normalizeAspect(body.aspectRatio);

      let userMessage: ChatMessage;
      try {
        userMessage = await service.appendUserMessage(projectId, text, attachments);
      } catch (err) {
        if (err instanceof WorkspaceInputError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }

      const stream = openEventStream(request, reply);
      const controller = new AbortController();
      const onClose = () => controller.abort();
      reply.raw.on("close", onClose);

      try {
        for await (const event of service.run(
          projectId,
          {
            text,
            kind: "auto",
            aspectRatio,
            attachments,
            userMessageId: userMessage.id,
            baseUrl: baseUrlFor(request),
            rawAttachmentCount: rawAttachments,
            requestId: request.id,
          },
          controller.signal,
        )) {
          if (!stream.send(event)) break;
        }
      } catch (err) {
        stream.send({
          type: "run.failed",
          runId: "",
          messageId: "",
          seq: 0,
          at: new Date().toISOString(),
          error: {
            code: "stream_error",
            message: err instanceof LlmError ? err.message : "生成失败，请重试",
            retriable: true,
          },
        });
      } finally {
        reply.raw.off("close", onClose);
        stream.close();
      }
    },
  );

  /** 卡片上的「再生成」：不追加用户消息，直接产出一条新的助手消息。 */
  app.post<{ Params: Params; Body: GenerateBody }>(
    "/workspace/:projectId/generate",
    async (request, reply) => {
      if (!(await ownProject(request, reply, request.params.projectId))) return;

      const projectId = request.params.projectId;
      const body = request.body ?? {};
      const kind = body.kind === "video" ? "video" : "image";
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const aspectRatio = normalizeAspect(body.aspectRatio);
      const attachments = await normalizeAttachments(body.attachments, baseUrlFor(request));
      const rawAttachments = Array.isArray(body.attachments) ? body.attachments.length : 0;
      if (rawAttachments > 0) {
        request.log.info(
          { raw: rawAttachments, accepted: attachments.length },
          "generate attachments",
        );
      }

      const stream = openEventStream(request, reply);
      const controller = new AbortController();
      const onClose = () => controller.abort();
      reply.raw.on("close", onClose);

      try {
        for await (const event of service.run(
          projectId,
          { text: prompt, kind, aspectRatio, attachments, baseUrl: baseUrlFor(request), rawAttachmentCount: rawAttachments, requestId: request.id },
          controller.signal,
        )) {
          if (!stream.send(event)) break;
        }
      } catch (err) {
        stream.send({
          type: "run.failed",
          runId: "",
          messageId: "",
          seq: 0,
          at: new Date().toISOString(),
          error: {
            code: "stream_error",
            message: err instanceof LlmError ? err.message : "生成失败，请重试",
            retriable: true,
          },
        });
      } finally {
        reply.raw.off("close", onClose);
        stream.close();
      }
    },
  );

  /** 前端 fallback 轮询：作业超时后继续查询，成功则刷新画布 */
  app.get<{ Params: Params & { jobId: string } }>(
    "/workspace/:projectId/jobs/:jobId",
    async (request, reply) => {
      if (!(await ownProject(request, reply, request.params.projectId))) return;
      const job = await getJob(request.params.projectId, request.params.jobId);
      if (!job) return reply.code(404).send({ error: "作业不存在" });
      return job;
    },
  );

  app.post<{ Params: Params & { jobId: string } }>(
    "/workspace/:projectId/jobs/:jobId/cancel",
    async (request, reply) => {
      if (!(await ownProject(request, reply, request.params.projectId))) return;
      const canceled = await cancelJob(request.params.projectId, request.params.jobId);
      if (!canceled) return reply.code(409).send({ error: "作业已完成或无法取消" });
      return reply.code(202).send({ ok: true });
    },
  );
}