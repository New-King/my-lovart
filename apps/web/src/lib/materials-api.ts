import { type LibraryMaterial, PUBLIC_MATERIALS } from "./public-materials";

/** 假装上传接口：素材只存在内存里，刷新页面后消失，接后端时替换这里。 */
const uploadedMaterials: LibraryMaterial[] = [];
let uploadCount = 0;

export async function fetchMaterials(): Promise<LibraryMaterial[]> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  return [...uploadedMaterials, ...PUBLIC_MATERIALS];
}

export async function uploadMaterial(file: File): Promise<LibraryMaterial> {
  await new Promise((resolve) => setTimeout(resolve, 600));
  uploadCount += 1;
  const material: LibraryMaterial = {
    id: `uploaded-${Date.now()}-${uploadCount}`,
    name: file.name.replace(/\.[^.]+$/, "") || "未命名素材",
    url: URL.createObjectURL(file),
    mimeType: file.type || "image/png",
    width: 0,
    height: 0,
    uploaded: true,
  };
  uploadedMaterials.unshift(material);
  return material;
}

export async function deleteMaterial(id: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const index = uploadedMaterials.findIndex((item) => item.id === id);
  const material = index === -1 ? undefined : uploadedMaterials[index];
  if (!material) return;
  URL.revokeObjectURL(material.url);
  uploadedMaterials.splice(index, 1);
}
