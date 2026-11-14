import { getDb } from "../../db/supabase.js";
import { STORAGE_BUCKET } from "./storage.js";

function fileIdsFromUrls(urls: string[]): string[] {
  const ids = new Set<string>();
  for (const url of urls) {
    const index = url.indexOf("/files/");
    if (index < 0) continue;
    const id = url.slice(index + "/files/".length).split(/[?#]/)[0];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** 删除项目前清掉画布文件与聊天附件，避免 Storage 里留孤儿。 */
export async function cleanupProjectStorage(projectId: string): Promise<void> {
  const db = getDb();
  const paths: string[] = [];

  try {
    const { data: files } = await db.storage.from(STORAGE_BUCKET).list(projectId, { limit: 1000 });
    for (const file of files ?? []) {
      paths.push(`${projectId}/${file.name}`);
    }
  } catch (err) {
    console.warn("[cleanup] 列画布文件失败：", err instanceof Error ? err.message : err);
  }

  try {
    const { data: assets } = await db
      .from("project_assets")
      .select("url")
      .eq("project_id", projectId);
    paths.push(
      ...fileIdsFromUrls((assets ?? []).map((row) => String(row.url ?? ""))).map(
        (id) => `attachments/${id}`,
      ),
    );
  } catch {
    // 迁移未执行时忽略
  }

  try {
    const { data: sessions } = await db
      .from("sessions")
      .select("id")
      .eq("project_id", projectId);
    const ids = (sessions ?? []).map((row) => row.id as string);
    if (ids.length > 0) {
      const { data: messages } = await db
        .from("messages")
        .select("attachments")
        .in("session_id", ids);
      const urls = (messages ?? []).flatMap((row) =>
        Array.isArray(row.attachments)
          ? row.attachments.map((item: { url?: unknown }) => String(item?.url ?? ""))
          : [],
      );
      paths.push(...fileIdsFromUrls(urls).map((id) => `attachments/${id}`));
    }
  } catch {
    // 没有 messages 表/列时忽略
  }

  const unique = [...new Set(paths)].filter(Boolean);
  if (unique.length === 0) return;
  const { error } = await db.storage.from(STORAGE_BUCKET).remove(unique);
  if (error) console.warn("[cleanup] Storage 清理失败：", error.message);
}