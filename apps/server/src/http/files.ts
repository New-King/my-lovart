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

    reply
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("access-control-allow-origin", "*")
      .header("accept-ranges", "bytes")
      .type(file.mimeType);

    // 视频拖动进度条需要 206；图片/小文件整段返回
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const total = file.data.byteLength;
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        if (Number.isFinite(start) && start <= end && start < total) {
          const chunk = file.data.subarray(start, end + 1);
          return reply
            .code(206)
            .header("content-range", `bytes ${start}-${end}/${total}`)
            .header("content-length", String(chunk.byteLength))
            .send(chunk);
        }
      }
    }

    return reply.header("content-length", String(file.data.byteLength)).send(file.data);
  });
}