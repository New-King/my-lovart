import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireUserId } from "../lib/auth.js";
import { env } from "../lib/env.js";
import {
  deleteUserMaterial,
  listUserMaterials,
  MaterialInputError,
  uploadUserMaterial,
  type UploadMaterialInput,
} from "../features/materials/materials.service.js";

import type { UserMaterial } from "../features/materials/materials.repository.js";

type Params = { id: string };

/** fileId 是 Storage 内部路径，不返回给客户端 */
function publicMaterial(material: UserMaterial) {
  const { fileId: _ignored, ...rest } = material;
  return rest;
}

function baseUrlFor(request: FastifyRequest): string {
  return `${request.protocol}://${request.headers.host ?? `127.0.0.1:${env.port}`}`;
}

/**
 * 用户素材库。按用户存，不按项目存：同一账号在不同项目里都能复用。
 * 文件本体走 /files/:id + Storage；这里只做引用和删除。
 */
export function registerMaterialRoutes(app: FastifyInstance) {
  app.get("/materials", async (request) => {
    const userId = await requireUserId(request);
    const materials = await listUserMaterials(userId);
    return materials.map(publicMaterial);
  });

  app.post<{ Body: UploadMaterialInput }>("/materials", async (request, reply) => {
    const userId = await requireUserId(request);
    try {
      const material = await uploadUserMaterial(userId, request.body ?? {}, baseUrlFor(request));
      return reply.code(201).send(publicMaterial(material));
    } catch (err) {
      if (err instanceof MaterialInputError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post<{ Params: Params }>("/materials/:id/delete", async (request, reply) => {
    const userId = await requireUserId(request);
    const ok = await deleteUserMaterial(userId, request.params.id);
    if (!ok) return reply.code(404).send({ error: "素材不存在" });
    return { ok: true };
  });
}