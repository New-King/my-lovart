import type { Storyboard } from "./storyboards.js";

/**
 * 一致性策略不是全局写死的流程，而是每个分镜自己的制作档位。
 *
 * - strict：客户给了产品实拍/明确要求“不能变形”。产品锚、细节锚必须有真实参考；
 *           多镜头必须按末帧衔接；缺任何一环都拒绝，避免交付不可控画面。
 * - adaptive（默认）：有实拍就用实拍；没有实拍允许生成产品设定图，并在结果里标注
 *           “设定图为生成图”。开盖等状态仍需先有细节锚（可以是基于设定图生成的），
 *           多镜头仍按末帧衔接，但缺参考不会一律卡死。
 * - loose：快速概念/草稿。没有锚图也能出关键帧；多镜头不强制尾帧与末帧衔接。
 *           输出会带 warning，适合用户明确说“先看个大概”。
 *
 * 这个字段存在 storyboard.metadata.consistency，不需要迁移；旧分镜默认 adaptive。
 */
export type ConsistencyPolicy = "strict" | "adaptive" | "loose";

export function readConsistencyPolicy(
  board: Pick<Storyboard, "metadata"> | null | undefined,
): ConsistencyPolicy {
  const value = board?.metadata?.consistency;
  return value === "strict" || value === "loose" ? value : "adaptive";
}

export function policyDescription(policy: ConsistencyPolicy): string {
  if (policy === "strict") {
    return "strict：产品锚/细节锚必须有真实参考图，多镜头必须按实际末帧衔接，缺环即拒绝";
  }
  if (policy === "loose") {
    return "loose：允许无锚图/无实拍先出草稿，不强制多镜头末帧衔接，结果会标注一致性风险";
  }
  return "adaptive：有实拍用实拍，无实拍可生成设定图并标注；开盖等状态仍需细节锚，多镜头按末帧衔接";
}