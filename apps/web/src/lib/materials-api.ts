import {
  createMaterial,
  deleteMaterialRecord,
  listMaterials,
  type MaterialRecord,
} from "./api";
import type { LibraryMaterial } from "./public-materials";
import { PUBLIC_MATERIALS } from "./public-materials";
import { prepareImageFile } from "@/hooks/use-image-attachments";

function toLibraryMaterial(record: MaterialRecord): LibraryMaterial {
  return {
    id: record.id,
    name: record.name,
    url: record.url,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    uploaded: true,
  };
}

/** 上传的素材存服务端（user_materials + /files + Storage），刷新后仍能读回。 */
export async function fetchMaterials(): Promise<LibraryMaterial[]> {
  const uploaded = await listMaterials();
  return [...uploaded.map(toLibraryMaterial), ...PUBLIC_MATERIALS];
}

async function measureImage(file: File): Promise<{ width?: number; height?: number }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return {};
  }
}

export async function uploadMaterial(file: File): Promise<LibraryMaterial> {
  // 和聊天附件同一条预处理：长边 1600、超 10MB 重编码，避免 base64 过大
  const prepared = await prepareImageFile(file);
  const measured = prepared.width ? {} : await measureImage(file);
  const name = file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "未命名素材";
  const record = await createMaterial({
    name,
    mimeType: prepared.mimeType,
    dataUrl: prepared.url,
    ...(prepared.width ?? measured.width
      ? { width: prepared.width ?? measured.width }
      : {}),
    ...(prepared.height ?? measured.height
      ? { height: prepared.height ?? measured.height }
      : {}),
  });
  return toLibraryMaterial(record);
}

export async function deleteMaterial(id: string): Promise<void> {
  // 公共素材只读；老版本内存里的 uploaded-* 记录服务端也没有
  if (!id || id.startsWith("uploaded-") || id.startsWith("poster-") || id.startsWith("insp-")) {
    return;
  }
  await deleteMaterialRecord(id);
}