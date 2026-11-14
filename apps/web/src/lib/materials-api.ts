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
    // 必须用 data URL：blob: 只在当前页面的内存里有效，
    // 发给服务端后既存不下来，也没法交给模型看。
    url: await fileToDataUrl(file),
    mimeType: file.type || "image/png",
    width: 0,
    height: 0,
    uploaded: true,
  };
  uploadedMaterials.unshift(material);
  return material;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("读取失败"));
    reader.onerror = () => reject(reader.error ?? new Error("读取失败"));
    reader.readAsDataURL(file);
  });
}

export async function deleteMaterial(id: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const index = uploadedMaterials.findIndex((item) => item.id === id);
  const material = index === -1 ? undefined : uploadedMaterials[index];
  if (!material) return;
  if (material.url.startsWith("blob:")) URL.revokeObjectURL(material.url);
  uploadedMaterials.splice(index, 1);
}
