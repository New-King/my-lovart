/**
 * 打印最近一次 run 的 trace。
 * 用法：pnpm --filter @my-lovart/server trace:latest
 *       pnpm --filter @my-lovart/server trace:latest <runId 片段>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../../../.traces");
const needle = process.argv[2] ?? "";

let files;
try {
  files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl") && (!needle || name.includes(needle)))
    .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
} catch {
  console.log(`还没有 trace：${dir}`);
  process.exit(0);
}

if (files.length === 0) {
  console.log(`没有匹配的 trace：${needle || "（目录为空）"}`);
  process.exit(0);
}

const file = path.join(dir, files[0].name);
console.log(`trace: ${file}\n`);

for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    console.log(line);
    continue;
  }
  const time = String(entry.at ?? "").slice(11, 23);
  const data = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
  console.log(`${time} ${entry.stage}${data}`);
}