import { chat } from "../../lib/llm.js";
import type { Project, ProjectsRepository } from "./projects.repository.js";

export const NAME_MAX = 60;

export class ProjectNameError extends Error {}

const DEFAULT_NAMES = new Set(["未命名项目", "新项目", "Untitled"]);

/** 模型没返回时也不能让项目卡在默认名上 */
function fallbackName(prompt: string): string {
  const cleaned = prompt
    .replace(/^(帮我|请|麻烦|想要|我要)+/g, "")
    .replace(/[，。；、！？,.!?：:\n]/g, " ")
    .replace(/\s+/g, "")
    .trim();
  return cleaned.slice(0, 12) || "新项目";
}

function cleanModelName(raw: string): string {
  return raw
    .split(/\r?\n/)[0]
    ?.replace(/^["'「『《]+|["'」』》]+$/g, "")
    .replace(/[，。；、！？,.!?：:]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .slice(0, 20) ?? "";
}

export function normalizeProjectName(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : "";
  if (!name) throw new ProjectNameError("项目名不能为空");
  if (name.length > NAME_MAX) throw new ProjectNameError(`项目名不能超过 ${NAME_MAX} 个字符`);
  return name;
}

export function createProjectsService(repo: ProjectsRepository) {
  return {
    list: (userId: string) => repo.list(userId),

    create: (userId: string, rawName: unknown) => repo.create(userId, normalizeProjectName(rawName)),

    rename: (userId: string, id: string, rawName: unknown) =>
      repo.rename(userId, id, normalizeProjectName(rawName)),

    remove: (userId: string, id: string) => repo.remove(userId, id),

    /**
     * 首次真正产生内容时，让模型根据第一条需求起名。
     * 已经手动改过名的项目不会被覆盖。
     */
    async autoName(userId: string, id: string, prompt: string): Promise<Project | null> {
      const project = await repo.find(userId, id);
      if (!project) return null;
      if (!DEFAULT_NAMES.has(project.name)) return project;

      let name = fallbackName(prompt);
      try {
        const raw = await chat([
          {
            role: "system",
            content:
              "你在给一个 AI 设计画布项目起名。根据用户的第一条需求，输出一个 2-6 个汉字的短名字，像「秋季海报」「极简品牌片」。只输出名字，不要引号、标点、解释。",
          },
          { role: "user", content: prompt.slice(0, 500) },
        ]);
        const cleaned = cleanModelName(raw);
        if (cleaned) name = cleaned;
      } catch {
        // 模型失败就用需求里的文字兜底，不影响项目创建
      }

      return repo.rename(userId, id, normalizeProjectName(name));
    },
  };
}
