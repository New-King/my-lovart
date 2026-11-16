import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FILE_ROUTE_PREFIX, getFile } from "../files/file.store.js";

const run = promisify(execFile);

function fileIdFromUrl(url: string): string | undefined {
  const marker = FILE_ROUTE_PREFIX;
  const index = url.indexOf(marker);
  if (index < 0) return undefined;
  return url.slice(index + marker.length).split(/[?#]/)[0];
}

async function readVideo(url: string): Promise<Buffer> {
  const id = fileIdFromUrl(url);
  if (id) {
    const stored = await getFile(id);
    if (stored) return stored.data;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载视频失败（HTTP ${response.status}）`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * 抽取视频实际最后一帧。
 * 找不到 ffmpeg / 视频编码不支持时返回 null，由调用方降级到 end_frame，不让整个生成 job 失败。
 */
export async function extractVideoLastFrame(url: string): Promise<Buffer | null> {
  let dir: string | undefined;
  try {
    const data = await readVideo(url);
    if (data.byteLength === 0) return null;
    dir = await mkdtemp(join(tmpdir(), "mylovart-frame-"));
    const input = join(dir, "input.mp4");
    const output = join(dir, "last.jpg");
    await writeFile(input, data);

    const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
    let lastError: unknown;
    for (const seek of ["-0.5", "-1"]) {
      try {
        await run(
          ffmpeg,
          ["-sseof", seek, "-i", input, "-frames:v", "1", "-q:v", "2", "-y", output],
          { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        );
        const frame = await readFile(output);
        if (frame.byteLength > 0) return frame;
      } catch (err) {
        lastError = err;
      }
    }
    console.warn(
      "[video-frame] 抽取末帧失败，降级到 end_frame：",
      lastError instanceof Error ? lastError.message : lastError,
    );
    return null;
  } catch (err) {
    console.warn(
      "[video-frame] 读取视频失败，跳过末帧：",
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}