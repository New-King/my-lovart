/**
 * 附件链路验收：客户端 data URL → 服务端归一化 → Agent 视觉上下文。
 * 用法：pnpm --filter @my-lovart/server verify:attachments
 * 会往 Storage 上传一个小文件，结束后删除。
 */
import { normalizeAttachments } from "../dist/features/workspace/workspace.service.js";
import { buildAttachmentContext } from "../dist/features/agent/context.js";
import { getDb } from "../dist/db/supabase.js";
import { STORAGE_BUCKET } from "../dist/features/files/storage.js";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const uploadedPaths = [];

try {
  const attachments = await normalizeAttachments(
    [{ id: "local-1", name: "参考图.png", mimeType: "image/png", url: png, size: 100 }],
    "http://127.0.0.1:3001",
  );
  check("附件被服务端接受", attachments.length === 1);
  const attachment = attachments[0];
  if (!attachment) throw new Error("附件没有归一化成功，后续检查无法进行");
  check("附件地址变成稳定的 /files 地址", attachment.url.includes("/files/"));
  check("MIME 从 data URL 保留下来", attachment.mimeType === "image/png");

  const fileId = attachment.url.split("/files/")[1];
  if (fileId) uploadedPaths.push(`attachments/${fileId}`);

  const context = await buildAttachmentContext(attachments);
  check("Agent 上下文拿到可发送的图片", Object.keys(context.map).length === 1);
  check("Agent 文本里包含 <input_images>", context.xml.includes("<input_images"));
  check("没有被标成 unavailable", !context.xml.includes("unavailable"), context.xml);

  // 读不出来的附件不能被静默丢掉：模型要知道「有图但打不开」
  const broken = await buildAttachmentContext([
    {
      id: "missing",
      name: "打不开.png",
      mimeType: "image/png",
      url: "http://127.0.0.1:3001/files/not-exists",
      size: 1,
    },
  ]);
  check("损坏附件仍出现在上下文里", broken.xml.includes('status="unavailable"'));

  // 非图片附件不进入视觉上下文
  const pdf = await buildAttachmentContext([
    {
      id: "doc",
      name: "说明.pdf",
      mimeType: "application/pdf",
      url: "http://127.0.0.1:3001/files/doc",
      size: 10,
    },
  ]);
  check("非图片附件不进入视觉上下文", pdf.xml === "" && Object.keys(pdf.map).length === 0);

  // 素材库上传曾经用 blob: 地址，服务端和模型都拿不到；必须被拒，不能假装成功
  const blob = await normalizeAttachments(
    [{ id: "blob-1", name: "素材.png", mimeType: "image/png", url: "blob:http://localhost:3000/x", size: 0 }],
    "http://127.0.0.1:3001",
  );
  check("blob: 附件被拒绝", blob.length === 0, JSON.stringify(blob));
} catch (err) {
  console.error("ERROR", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  if (uploadedPaths.length > 0) {
    const { error } = await getDb().storage.from(STORAGE_BUCKET).remove(uploadedPaths);
    console.log(error ? `清理失败：${error.message}` : `已清理 ${uploadedPaths.length} 个测试文件`);
  }
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`${failed.length} 项失败`);
  process.exitCode = 1;
} else {
  console.log("附件链路验证通过");
}