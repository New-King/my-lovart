/**
 * 灵感搜索验收：不调用真实 Pexels，用假 fetch 验证鉴权、参数、映射和工具产物。
 * 真实验收需要 PEXELS_API_KEY；这边只覆盖接口契约，避免消耗额度。
 * 用法：pnpm --filter @my-lovart/server verify:inspiration
 */
import { randomUUID } from "node:crypto";

process.env.PEXELS_API_KEY = "test-pexels-key";

const { searchPexelsPhotos } = await import(
  "../dist/features/inspiration/pexels.js"
);
const { createAgentTools } = await import("../dist/features/agent/tools.js");
const { env } = await import("../dist/lib/env.js");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const requestedUrls = [];
let responseMode = "ok";

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  requestedUrls.push({ url, init });
  if (responseMode === "unauthorized") {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({
      photos: [
        {
          id: 101,
          width: 1200,
          height: 1800,
          url: "https://www.pexels.com/photo/101",
          photographer: "Tester",
          alt: "Morning window light",
          src: {
            large2x: "https://images.pexels.com/photos/101/large2x.jpg",
            large: "https://images.pexels.com/photos/101/large.jpg",
          },
        },
        {
          id: 102,
          width: 1200,
          height: 1800,
          url: "https://www.pexels.com/photo/102",
          photographer: "Tester",
          alt: "White bottle on wooden table",
          src: {
            large: "https://images.pexels.com/photos/102/large.jpg",
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

try {
  const items = await searchPexelsPhotos({
    query: "morning light white bottle",
    orientation: "portrait",
    perPage: 4,
  });
  check("Pexels 结果映射为统一 InspirationItem", items.length === 2, `${items.length} 张`);
  check(
    "优先使用 large2x / 主图地址",
    items[0]?.imageUrl.includes("large2x") &&
      items[1]?.imageUrl.includes("/102/large.jpg"),
    items[0]?.imageUrl,
  );
  check(
    "保留摄影师与来源链接",
    items[0]?.source.includes("Pexels") &&
      items[0]?.sourceUrl === "https://www.pexels.com/photo/101",
  );

  const first = requestedUrls[0];
  const url = new URL(first.url);
  check(
    "请求路径和参数正确",
    url.origin === "https://api.pexels.com" &&
      url.pathname === "/v1/search" &&
      url.searchParams.get("query") === "morning light white bottle" &&
      url.searchParams.get("orientation") === "portrait" &&
      url.searchParams.get("per_page") === "4",
    url.pathname,
  );
  check(
    "Authorization 使用 PEXELS_API_KEY（不打印值）",
    first.init?.headers?.authorization === "test-pexels-key",
  );

  const context = {
    bus: { push() {} },
    projectId: randomUUID(),
    runStartedAt: new Date().toISOString(),
    attachmentMap: {},
    canvasSummary: "",
    canvasElements: [],
    projectAssets: [],
    baseUrl: "http://127.0.0.1:3001",
    signal: new AbortController().signal,
  };
  const tools = createAgentTools(context);
  const searchTool = tools.find((item) => item.name === "search_inspiration");
  const output = JSON.parse(
    await searchTool.invoke({
      title: "通勤方向参考",
      directions: [
        { label: "日系留白", query: "japanese minimal still life morning light" },
        { label: "暗调产品", query: "dark moody product photography" },
      ],
      orientation: "portrait",
      perPage: 2,
    }),
  );
  check(
    "工具返回 2 组 inspiration block",
    Array.isArray(output.artifacts) &&
      output.artifacts.length === 2 &&
      output.artifacts.every((block) => block.type === "inspiration" && block.items.length === 2),
    `${output.artifacts?.length ?? 0} 组`,
  );
  check(
    "工具 summary 明确要求用户选方向",
    typeof output.summary === "string" && output.summary.includes("让用户看图选方向"),
    output.summary,
  );
  check(
    "工具返回可文字引用的 selection 编号",
    Array.isArray(output.selection) &&
      output.selection.length === 2 &&
      output.selection[0].items[1].ref === "G1-2" &&
      output.selection[1].items[0].ref === "G2-1" &&
      output.selection[1].items[0].imageUrl ===
        "https://images.pexels.com/photos/101/large2x.jpg",
    JSON.stringify(output.selection?.[0]?.items?.map((item) => item.ref)),
  );
  check(
    "summary 说明“第几组第几张”直接映射到 imageUrl",
    output.summary.includes("第几组第几张") && output.summary.includes("inputImages"),
  );

  const savedKey = env.pexelsApiKey;
  env.pexelsApiKey = "";
  const toolsWithoutKey = createAgentTools(context);
  const searchWithoutKey = toolsWithoutKey.find(
    (item) => item.name === "search_inspiration",
  );
  const failure = JSON.parse(
    await searchWithoutKey.invoke({
      title: "无 key 测试",
      directions: [{ label: "极简", query: "minimal still life" }],
    }),
  );
  check(
    "未配置 key 时工具仍注册，调用会失败（过程可标红）",
    Boolean(searchWithoutKey) && failure.code === "invalid_config",
    failure.code ?? failure.error ?? "missing",
  );
  env.pexelsApiKey = savedKey;

  responseMode = "unauthorized";
  let authError = "";
  try {
    await searchPexelsPhotos({ query: "test" });
  } catch (error) {
    authError = error instanceof Error ? error.message : String(error);
  }
  check("Pexels 401 映射为 invalid_config", /401/.test(authError), authError || "allowed");

  let emptyQuery = "";
  try {
    await searchPexelsPhotos({ query: "   " });
  } catch (error) {
    emptyQuery = error instanceof Error ? error.message : String(error);
  }
  check("空关键词被拒绝", /缺少关键词/.test(emptyQuery), emptyQuery || "allowed");
} catch (error) {
  results.push({ name: "执行灵感搜索验收", ok: false });
  console.error("FAIL 执行灵感搜索验收 —", error instanceof Error ? error.message : error);
} finally {
  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exitCode = failed === 0 ? 0 : 1;
}