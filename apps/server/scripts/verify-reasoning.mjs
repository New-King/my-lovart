/**
 * 思维链流解析契约：不调用模型，验证不同供应商的 chunk 形状都能识别。
 * 真实链路（事件顺序、持久化、不进最终回答）用 run:reasoning-probe。
 *
 * 用法：pnpm --filter @my-lovart/server verify:reasoning
 */
const { readChunkReasoning, chunkHasToolCalls } = await import(
  "../dist/features/agent/runtime.js"
);

const checks = [
  {
    name: "DeepSeek：additional_kwargs.reasoning_content",
    pass:
      readChunkReasoning({
        additional_kwargs: { reasoning_content: "先判断用户要的是直接出片。" },
      }) === "先判断用户要的是直接出片。",
    detail: "string → string",
  },
  {
    name: "Anthropic 风格：content 里的 thinking 块",
    pass:
      readChunkReasoning({
        content: [
          { type: "thinking", thinking: "对比两套方案。" },
          { type: "text", text: "这是正文" },
        ],
      }) === "对比两套方案。",
    detail: "只取 thinking，不混入正文",
  },
  {
    name: "OpenAI 风格：content 里的 reasoning 块",
    pass:
      readChunkReasoning({ content: [{ type: "reasoning", text: "先算 17+25。" }] }) ===
      "先算 17+25。",
    detail: "reasoning.text",
  },
  {
    name: "空 reasoning / null 不产生思考",
    pass:
      readChunkReasoning({ additional_kwargs: { reasoning_content: "" } }) === "" &&
      readChunkReasoning({ additional_kwargs: { reasoning_content: null } }) === "",
    detail: "空串和 null 都忽略",
  },
  {
    name: "普通正文不会被误当成思考",
    pass:
      readChunkReasoning({ content: [{ type: "text", text: "17 加 25 等于 42。" }] }) === "",
    detail: "text 块被忽略",
  },
  {
    name: "识别工具调用 chunk（用于结束当前思考段）",
    pass:
      chunkHasToolCalls({ tool_call_chunks: [{ name: "inspect_canvas" }] }) === true &&
      chunkHasToolCalls({ tool_calls: [{ name: "inspect_canvas" }] }) === true &&
      chunkHasToolCalls({ content: "普通文本" }) === false,
    detail: "tool_call_chunks / tool_calls",
  },
];

let failed = 0;
for (const check of checks) {
  console.log(`${check.pass ? "✓" : "✗"} ${check.name} · ${check.detail}`);
  if (!check.pass) failed += 1;
}

console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);