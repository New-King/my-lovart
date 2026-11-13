import { env } from "../../lib/env.js";
import { chat } from "../../lib/llm.js";
import { buildMockReply } from "./mock-agent.js";
import {
  MAX_CONTEXT_MESSAGES,
  appendMessage,
  getWorkspace,
  saveElements,
  type Workspace,
} from "./workspace.store.js";

export const MESSAGE_MAX = 4000;

export class WorkspaceInputError extends Error {}

const SYSTEM_PROMPT = `你是 mylovart 的 AI 设计助手，一个画布类设计工具里的对话角色。

要求：
- 用中文回答，简洁、具体、可执行。给建议时落到构图、配色（给出色值）、字体、尺寸这些层面。
- 不要写客套话和总结段落。
- 当前版本你只能对话，不能在画布上绘图。不要声称你已经画好了或正在生成，也不要让用户去点不存在的按钮。`;

export function createWorkspaceService() {
  return {
    get(projectId: string): Workspace {
      return getWorkspace(projectId);
    },

    saveCanvas(projectId: string, elements: unknown, files?: unknown): Workspace {
      if (!Array.isArray(elements)) throw new WorkspaceInputError("elements 必须是数组");
      if (files !== undefined && (typeof files !== "object" || files === null || Array.isArray(files))) {
        throw new WorkspaceInputError("files 必须是对象");
      }
      return saveElements(projectId, elements, files as Record<string, unknown> | undefined);
    },

    async sendMessage(projectId: string, rawText: unknown): Promise<Workspace> {
      const text = typeof rawText === "string" ? rawText.trim() : "";
      if (!text) throw new WorkspaceInputError("消息不能为空");
      if (text.length > MESSAGE_MAX) throw new WorkspaceInputError("消息过长");

      appendMessage(projectId, "user", text);

      if (env.agentMode === "mock") {
        await new Promise((resolve) => setTimeout(resolve, 450));
        const reply = buildMockReply(text);
        appendMessage(projectId, "assistant", reply.content, reply.blocks);
        return getWorkspace(projectId);
      }

      const workspace = getWorkspace(projectId);
      const history = workspace.messages
        .slice(-MAX_CONTEXT_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content }));

      const reply = await chat([{ role: "system", content: SYSTEM_PROMPT }, ...history]);
      appendMessage(projectId, "assistant", reply || "（模型没有返回内容）");

      return getWorkspace(projectId);
    },
  };
}
