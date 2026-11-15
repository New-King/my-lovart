/**
 * 判断异常是否来自 LangGraph checkpoint / pg 连接。
 * checkpoint 是执行记忆的加速层，不是产品数据的来源；它失败时不应该
 * 把已经产出图片/文字的整轮运行判死。
 */
export function isCheckpointError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error ?? "");
  return /checkpoint-postgres|langgraph-checkpoint|pg-pool|timeout exceeded when trying to connect|Connection terminated|ECONNRESET|ECONNREFUSED/i.test(
    text,
  );
}