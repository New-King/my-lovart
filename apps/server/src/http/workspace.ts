import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RunEvent } from "@my-lovart/shared";
import { env } from "../lib/env.js";
import { requireUserId } from "../lib/auth.js";
import { LlmError } from "../lib/llm.js";
import {
  MESSAGE_MAX,
  WorkspaceInputError,
  createWorkspaceService,
  normalizeAspect,
  normalizeAttachments,
} from "../features/workspace/workspace.service.js";

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

export function registerWorkspaceRoutes(app: FastifyInstance) {
  const service = createWorkspaceService();

  app.get<{ Params: Params }>("/workspace/:projectId", async (request) => {
    await requireUserId(request);
    return service.get(request.params.projectId);
  });

  app.put<{ Params: Params; Body: { elements?: unknown; files?: unknown } }>(
    "/workspace/:projectId/canvas",
    async (request, reply) => {
      try {
        await requireUserId(request);
        service.saveCanvas(
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
      await requireUserId(request);

      const projectId = request.params.projectId;
      const body = request.body ?? {};
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length > MESSAGE_MAX) {
        return reply.code(400).send({ error: "消息过长" });
      }

      const attachments = normalizeAttachments(body.attachments, baseUrlFor(request));
      if (!text && attachments.length === 0) {
        return reply.code(400).send({ error: "消息不能为空" });
      }
      const aspectRatio = normalizeAspect(body.aspectRatio);

      try {
        service.appendUserMessage(projectId, text, attachments);
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
          { text, kind: "auto", aspectRatio, attachments, baseUrl: baseUrlFor(request) },
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
      await requireUserId(request);

      const projectId = request.params.projectId;
      const body = request.body ?? {};
      const kind = body.kind === "video" ? "video" : "image";
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const aspectRatio = normalizeAspect(body.aspectRatio);
      const attachments = normalizeAttachments(body.attachments, baseUrlFor(request));

      const stream = openEventStream(request, reply);
      const controller = new AbortController();
      const onClose = () => controller.abort();
      reply.raw.on("close", onClose);

      try {
        for await (const event of service.run(
          projectId,
          { text: prompt, kind, aspectRatio, attachments, baseUrl: baseUrlFor(request) },
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
}