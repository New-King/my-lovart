import { normalizeAttachment } from "../files/file.store.js";
import { deleteFile } from "../files/file.store.js";
import { removeStoredFile } from "../files/storage.js";
import {
  getMaterialsRepository,
  newMaterialId,
  type MaterialsRepository,
  type UserMaterial,
} from "./materials.repository.js";

export class MaterialInputError extends Error {}

export type UploadMaterialInput = {
  name?: unknown;
  mimeType?: unknown;
  dataUrl?: unknown;
  width?: unknown;
  height?: unknown;
};

const MAX_NAME = 120;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/**
 * 上传素材：data URL → /files/:id + Storage，再写 user_materials。
 * 返回的是可长期引用的记录；刷新后前端从 /materials 重新读。
 */
export async function uploadUserMaterial(
  userId: string,
  input: UploadMaterialInput,
  baseUrl: string,
  repository: MaterialsRepository = getMaterialsRepository(),
): Promise<UserMaterial> {
  const dataUrl = asString(input.dataUrl);
  if (!dataUrl.startsWith("data:image/")) {
    throw new MaterialInputError("只支持图片素材（PNG/JPEG/WebP/GIF）");
  }

  const fallbackName = "未命名素材";
  const rawName = asString(input.name) || fallbackName;
  const name = rawName.slice(0, MAX_NAME);
  const mimeType = asString(input.mimeType) || "image/png";

  const attachment = await normalizeAttachment(
    {
      name,
      mimeType,
      url: dataUrl,
      ...(asNumber(input.width) ? { width: asNumber(input.width) } : {}),
      ...(asNumber(input.height) ? { height: asNumber(input.height) } : {}),
    },
    baseUrl,
  );
  if (!attachment) {
    throw new MaterialInputError("图片读取失败，或文件超过 12MB");
  }

  const material: UserMaterial = {
    id: newMaterialId(),
    name,
    url: attachment.url,
    fileId: attachment.id,
    mimeType: attachment.mimeType,
    size: attachment.size,
    width: asNumber(input.width) ?? attachment.width ?? 0,
    height: asNumber(input.height) ?? attachment.height ?? 0,
    createdAt: new Date().toISOString(),
  };
  await repository.save(userId, material);
  return material;
}

export async function listUserMaterials(
  userId: string,
  repository: MaterialsRepository = getMaterialsRepository(),
): Promise<UserMaterial[]> {
  return repository.list(userId);
}

/** 删除记录，并清掉文件副本；Storage 清理失败不影响删除结果。 */
export async function deleteUserMaterial(
  userId: string,
  id: string,
  repository: MaterialsRepository = getMaterialsRepository(),
): Promise<boolean> {
  const removed = await repository.remove(userId, id);
  if (!removed) return false;

  deleteFile(removed.fileId);
  const cleaned = await removeStoredFile(`attachments/${removed.fileId}`).catch(() => false);
  if (!cleaned) {
    console.warn(
      `[materials] 素材 ${removed.id} 已从库删除，但 Storage 对象清理失败；文件 ${removed.fileId}`,
    );
  }
  return true;
}