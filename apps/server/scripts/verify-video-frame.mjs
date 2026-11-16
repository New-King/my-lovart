/**
 * 视频末帧抽取验收：生成 1 秒测试视频，通过 HTTP 提供，抽取最后一帧并检查 JPEG。
 * ffmpeg 不在 PATH 时跳过（生产环境会降级到 end_frame，不失败 job）。
 * 用法：pnpm --filter @my-lovart/server verify:video-frame
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { importFileBuffer } from "../dist/features/files/file.store.js";
import { extractVideoLastFrame } from "../dist/features/generation/video-frame.js";

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
let dir;
let skipped = false;

try {
  dir = await mkdtemp(join(tmpdir(), "mylovart-frame-test-"));
  const videoPath = join(dir, "test.mp4");
  try {
    await run(
      ffmpeg,
      [
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x240:d=1",
        "-pix_fmt",
        "yuv420p",
        "-y",
        videoPath,
      ],
      { timeout: 30_000 },
    );
  } catch (err) {
    if (err instanceof Error && /ENOENT/.test(err.message)) {
      console.log("SKIP 未找到 ffmpeg，跳过末帧抽取（生产会降级到 end_frame）");
      skipped = true;
      process.exitCode = 0;
    } else {
      throw err;
    }
  }

  if (!skipped) {
    const data = await readFile(videoPath);
    const server = createServer((req, res) => {
      if (req.url === "/test.mp4") {
        res.writeHead(200, { "content-type": "video/mp4", "content-length": data.length });
        res.end(data);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const frame = await extractVideoLastFrame(`http://127.0.0.1:${port}/test.mp4`);
      const ok = Boolean(frame && frame.length > 100 && frame[0] === 0xff && frame[1] === 0xd8);
      console.log(`${ok ? "PASS" : "FAIL"} 抽取视频实际末帧（HTTP） — ${frame?.length ?? 0} bytes`);
      const local = await importFileBuffer(
        data,
        "video/mp4",
        "test.mp4",
        "http://127.0.0.1:3001",
      );
      const localFrame = await extractVideoLastFrame(local.url);
      const localOk = Boolean(
        localFrame && localFrame.length > 100 && localFrame[0] === 0xff && localFrame[1] === 0xd8,
      );
      console.log(
        `${localOk ? "PASS" : "FAIL"} 抽取视频实际末帧（/files 本地） — ${localFrame?.length ?? 0} bytes`,
      );
      process.exitCode = ok && localOk ? 0 : 1;
    } finally {
      server.close();
    }
  }
} finally {
  if (dir) await rm(dir, { recursive: true, force: true });
}