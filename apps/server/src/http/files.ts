import type { FastifyInstance } from "fastify";
import { getFile } from "../features/files/file.store.js";

type Params = { id: string };

/**
 * 附件地址故意不校验登录：<img>/<video>/下载都带不上 Authorization 头，
 * id 是不可猜的 UUID，且只在用户自己的消息里出现。
 */
export function registerFileRoutes(app: FastifyInstance) {
  app.get<{ Params: Params }>("/files/:id", async (request, reply) => {
    const file = getFile(request.params.id);
    if (!file) return reply.code(404).send({ error: "文件不存在" });

    return reply
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("access-control-allow-origin", "*")
      .type(file.mimeType)
      .send(file.data);
  });
}