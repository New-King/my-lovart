/** 下载远端资源：优先拿 blob 触发保存，跨域被拒时退回新窗口打开。 */
export async function downloadAsset(url: string, name: string): Promise<void> {
  const filename = sanitizeName(name, extensionOf(url));

  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) throw new Error(`下载失败 ${response.status}`);

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  } catch {
    // 图片有 CORS、视频源不一定有：退回让浏览器自己处理
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function extensionOf(url: string): string {
  const path = url.split("?")[0] ?? "";
  const match = /\.([a-z0-9]{2,5})$/i.exec(path);
  return match?.[1]?.toLowerCase() ?? "png";
}

function sanitizeName(name: string, extension: string): string {
  const base = (name || "mylovart")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${base || "mylovart"}.${extension}`;
}