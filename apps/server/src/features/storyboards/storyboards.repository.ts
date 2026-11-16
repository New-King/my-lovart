import { randomUUID } from "node:crypto";
import { getDb } from "../../db/supabase.js";
import { env } from "../../lib/env.js";
import { getAssetsRepository } from "../assets/assets.repository.js";
import {
  activeShots,
  shotCounts,
  snapshotOf,
  type CreateStoryboardInput,
  type Storyboard,
  type StoryboardDetail,
  type StoryboardRevision,
  type StoryboardShot,
  type StoryboardSnapshot,
  type StoryboardStatus,
  type StoryboardSummary,
  type UpdateShotInput,
  type UpdateStoryboardInput,
} from "./storyboards.js";

export class StoryboardNotFoundError extends Error {
  constructor(message = "分镜不存在") {
    super(message);
    this.name = "StoryboardNotFoundError";
  }
}

export class StoryboardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryboardValidationError";
  }
}

export type StoryboardRevisionSummary = {
  id: string;
  reason: string;
  createdAt: string;
};

export type StoryboardsRepository = {
  list(projectId: string): Promise<StoryboardSummary[]>;
  get(projectId: string, storyboardId: string): Promise<StoryboardDetail | null>;
  getShot(
    projectId: string,
    shotId: string,
  ): Promise<{ storyboard: Storyboard; shot: StoryboardShot } | null>;
  create(projectId: string, input: CreateStoryboardInput): Promise<StoryboardDetail>;
  updateStoryboard(
    projectId: string,
    storyboardId: string,
    patch: UpdateStoryboardInput,
  ): Promise<StoryboardDetail>;
  updateShot(
    projectId: string,
    shotId: string,
    patch: UpdateShotInput,
  ): Promise<StoryboardShot>;
  reorder(
    projectId: string,
    storyboardId: string,
    orderedShotIds: string[],
  ): Promise<StoryboardDetail>;
  deleteShot(projectId: string, shotId: string): Promise<void>;
  resetShot(projectId: string, shotId: string): Promise<StoryboardShot>;
  resetStoryboard(projectId: string, storyboardId: string): Promise<StoryboardDetail>;
  restoreStoryboard(
    projectId: string,
    storyboardId: string,
    revisionId: string,
  ): Promise<StoryboardDetail>;
  setShotAsset(
    projectId: string,
    shotId: string,
    assetId: string | null,
  ): Promise<StoryboardShot>;
  setCanonAsset(
    projectId: string,
    storyboardId: string,
    assetId: string | null,
  ): Promise<Storyboard>;
  setAnchorAsset(
    projectId: string,
    storyboardId: string,
    anchorType: "product" | "product_detail" | "character" | "scene" | "style",
    assetId: string | null,
  ): Promise<Storyboard>;
  /** 生成作业完成后由 worker 调用；幂等 */
  applyFirstFrame(projectId: string, shotId: string, assetId: string): Promise<void>;
  applyEndFrame(projectId: string, shotId: string, assetId: string): Promise<void>;
  applyVideo(projectId: string, shotId: string, assetId: string): Promise<void>;
  applyVideoLastFrame(projectId: string, shotId: string, assetId: string): Promise<void>;
  listRevisions(
    projectId: string,
    storyboardId: string,
    limit?: number,
  ): Promise<StoryboardRevisionSummary[]>;
};

type BoardRow = {
  id: string;
  project_id: string;
  title: string;
  brief: string;
  kind: Storyboard["kind"];
  aspect_ratio: string | null;
  style: string | null;
  canon_asset_id: string | null;
  product_detail_anchor_asset_id: string | null;
  character_anchor_asset_id: string | null;
  scene_anchor_asset_id: string | null;
  style_anchor_asset_id: string | null;
  total_duration_seconds: number | null;
  status: StoryboardStatus;
  active: boolean;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type ShotRow = {
  id: string;
  storyboard_id: string;
  order_index: number;
  title: string;
  description: string;
  prompt: string;
  duration_seconds: number | null;
  camera: string | null;
  transition: string | null;
  scene_goal: string | null;
  continuity_note: string | null;
  negative_prompt: string | null;
  active_asset_id: string | null;
  first_frame_asset_id: string | null;
  end_frame_asset_id: string | null;
  video_asset_id: string | null;
  video_last_frame_asset_id: string | null;
  status: StoryboardShot["status"];
  metadata: unknown;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

const BOARD_COLUMNS =
  "id, project_id, title, brief, kind, aspect_ratio, style, canon_asset_id, product_detail_anchor_asset_id, character_anchor_asset_id, scene_anchor_asset_id, style_anchor_asset_id, total_duration_seconds, status, active, metadata, created_at, updated_at";
const SHOT_COLUMNS =
  "id, storyboard_id, order_index, title, description, prompt, duration_seconds, camera, transition, scene_goal, continuity_note, negative_prompt, active_asset_id, first_frame_asset_id, end_frame_asset_id, video_asset_id, video_last_frame_asset_id, status, metadata, deleted_at, created_at, updated_at";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toBoard(row: BoardRow): Storyboard {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    brief: row.brief ?? "",
    kind: row.kind ?? "image",
    ...(row.aspect_ratio ? { aspectRatio: row.aspect_ratio } : {}),
    ...(row.style ? { style: row.style } : {}),
    ...(row.canon_asset_id ? { canonAssetId: row.canon_asset_id } : {}),
    ...(row.product_detail_anchor_asset_id
      ? { productDetailAnchorAssetId: row.product_detail_anchor_asset_id }
      : {}),
    ...(row.character_anchor_asset_id
      ? { characterAnchorAssetId: row.character_anchor_asset_id }
      : {}),
    ...(row.scene_anchor_asset_id ? { sceneAnchorAssetId: row.scene_anchor_asset_id } : {}),
    ...(row.style_anchor_asset_id ? { styleAnchorAssetId: row.style_anchor_asset_id } : {}),
    ...(row.total_duration_seconds
      ? { totalDurationSeconds: Number(row.total_duration_seconds) }
      : {}),
    status: row.status,
    active: row.active,
    metadata: asRecord(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toShot(row: ShotRow): StoryboardShot {
  return {
    id: row.id,
    storyboardId: row.storyboard_id,
    orderIndex: row.order_index,
    title: row.title,
    description: row.description ?? "",
    prompt: row.prompt ?? "",
    ...(row.duration_seconds ? { durationSeconds: Number(row.duration_seconds) } : {}),
    ...(row.camera ? { camera: row.camera } : {}),
    ...(row.transition ? { transition: row.transition } : {}),
    ...(row.scene_goal ? { sceneGoal: row.scene_goal } : {}),
    ...(row.continuity_note ? { continuityNote: row.continuity_note } : {}),
    ...(row.negative_prompt ? { negativePrompt: row.negative_prompt } : {}),
    ...(row.active_asset_id ? { activeAssetId: row.active_asset_id } : {}),
    ...(row.first_frame_asset_id ? { firstFrameAssetId: row.first_frame_asset_id } : {}),
    ...(row.end_frame_asset_id ? { endFrameAssetId: row.end_frame_asset_id } : {}),
    ...(row.video_asset_id ? { videoAssetId: row.video_asset_id } : {}),
    ...(row.video_last_frame_asset_id
      ? { videoLastFrameAssetId: row.video_last_frame_asset_id }
      : {}),
    status: row.status,
    metadata: asRecord(row.metadata),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type TimelineShot = { title: string; durationSeconds?: number };

function assertVideoTimeline(
  kind: "image" | "video" | undefined,
  total: number | undefined,
  shots: TimelineShot[],
): void {
  if (kind !== "video") return;
  if (!total || total < 4 || total > 15) {
    throw new StoryboardValidationError("视频分镜必须给 totalDurationSeconds，4-15 秒");
  }
  const maxShots = Math.floor(total / 4);
  if (shots.length > maxShots) {
    throw new StoryboardValidationError(
      `总时长 ${total} 秒最多 ${maxShots} 个镜头（每段至少 4 秒）。${total} 秒不是短视频，不要拆成 ${shots.length} 段`,
    );
  }
  for (const shot of shots) {
    const duration = shot.durationSeconds;
    if (!duration || duration < 4 || duration > 15) {
      throw new StoryboardValidationError(
        `镜头「${shot.title}」必须给 4-15 秒时长（视频 provider 单段最短 4 秒）`,
      );
    }
  }
  const sum = shots.reduce((acc, shot) => acc + (shot.durationSeconds ?? 0), 0);
  if (Math.abs(sum - total) > 0.01) {
    throw new StoryboardValidationError(
      `镜头时长合计 ${sum} 秒，和总时长 ${total} 秒不一致；必须正好覆盖整条片子`,
    );
  }
}

function assertShots(input: CreateStoryboardInput): void {
  if (!input.title.trim()) throw new StoryboardValidationError("分镜标题不能为空");
  if (input.shots.length === 0) throw new StoryboardValidationError("至少需要一个镜头");
  if (input.shots.length > 12) throw new StoryboardValidationError("一个分镜最多 12 个镜头");
  for (const shot of input.shots) {
    if (!shot.title.trim()) throw new StoryboardValidationError("镜头标题不能为空");
  }
  assertVideoTimeline(input.kind, input.totalDurationSeconds, input.shots);
}

function boardPatch(patch: UpdateStoryboardInput): Record<string, unknown> {
  const value: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) value.title = patch.title;
  if (patch.brief !== undefined) value.brief = patch.brief;
  if (patch.kind !== undefined) value.kind = patch.kind;
  if (patch.aspectRatio !== undefined) value.aspect_ratio = patch.aspectRatio;
  if (patch.style !== undefined) value.style = patch.style;
  if (patch.canonAssetId !== undefined) value.canon_asset_id = patch.canonAssetId;
  if (patch.totalDurationSeconds !== undefined) {
    value.total_duration_seconds = patch.totalDurationSeconds;
  }
  if (patch.status !== undefined) value.status = patch.status;
  if (patch.active !== undefined) value.active = patch.active;
  return value;
}

function shotPatch(patch: UpdateShotInput): Record<string, unknown> {
  const value: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) value.title = patch.title;
  if (patch.description !== undefined) value.description = patch.description;
  if (patch.prompt !== undefined) value.prompt = patch.prompt;
  if (patch.durationSeconds !== undefined) value.duration_seconds = patch.durationSeconds;
  if (patch.camera !== undefined) value.camera = patch.camera;
  if (patch.transition !== undefined) value.transition = patch.transition;
  if (patch.sceneGoal !== undefined) value.scene_goal = patch.sceneGoal;
  if (patch.continuityNote !== undefined) value.continuity_note = patch.continuityNote;
  if (patch.negativePrompt !== undefined) value.negative_prompt = patch.negativePrompt;
  if (patch.status !== undefined) value.status = patch.status;
  return value;
}

function createSupabaseStoryboardsRepository(): StoryboardsRepository {
  const db = () => getDb();

  async function getDetail(
    projectId: string,
    storyboardId: string,
  ): Promise<StoryboardDetail | null> {
    const { data: board, error } = await db()
      .from("storyboards")
      .select(BOARD_COLUMNS)
      .eq("project_id", projectId)
      .eq("id", storyboardId)
      .maybeSingle();
    if (error) throw error;
    if (!board) return null;
    const { data: shots, error: shotError } = await db()
      .from("storyboard_shots")
      .select(SHOT_COLUMNS)
      .eq("storyboard_id", storyboardId)
      .order("order_index", { ascending: true });
    if (shotError) throw shotError;
    return {
      storyboard: toBoard(board as BoardRow),
      shots: ((shots ?? []) as ShotRow[]).map(toShot),
    };
  }

  async function writeRevision(
    storyboardId: string,
    reason: string,
    snapshot: StoryboardSnapshot,
  ): Promise<void> {
    const { error } = await db().from("storyboard_revisions").insert({
      storyboard_id: storyboardId,
      reason,
      snapshot,
    });
    if (error) throw error;
  }

  async function requireShot(
    projectId: string,
    shotId: string,
  ): Promise<{ storyboard: Storyboard; shot: StoryboardShot }> {
    const { data: shot, error } = await db()
      .from("storyboard_shots")
      .select(SHOT_COLUMNS)
      .eq("id", shotId)
      .maybeSingle();
    if (error) throw error;
    if (!shot) throw new StoryboardNotFoundError("镜头不存在");
    const row = shot as ShotRow;
    const { data: board, error: boardError } = await db()
      .from("storyboards")
      .select(BOARD_COLUMNS)
      .eq("project_id", projectId)
      .eq("id", row.storyboard_id)
      .maybeSingle();
    if (boardError) throw boardError;
    if (!board) throw new StoryboardNotFoundError("镜头不属于这个项目");
    return { storyboard: toBoard(board as BoardRow), shot: toShot(row) };
  }

  async function requireBoard(
    projectId: string,
    storyboardId: string,
  ): Promise<StoryboardDetail> {
    const detail = await getDetail(projectId, storyboardId);
    if (!detail) throw new StoryboardNotFoundError();
    return detail;
  }

  return {
    async list(projectId) {
      const { data, error } = await db()
        .from("storyboards")
        .select(BOARD_COLUMNS)
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const boards = ((data ?? []) as BoardRow[]).map(toBoard);
      if (boards.length === 0) return [];
      const { data: shots, error: shotError } = await db()
        .from("storyboard_shots")
        .select("storyboard_id, status, deleted_at")
        .in(
          "storyboard_id",
          boards.map((board) => board.id),
        )
        .is("deleted_at", null);
      if (shotError) throw shotError;
      const byBoard = new Map<string, { shotCount: number; readyCount: number }>();
      for (const row of (shots ?? []) as {
        storyboard_id: string;
        status: string;
      }[]) {
        const counts = byBoard.get(row.storyboard_id) ?? {
          shotCount: 0,
          readyCount: 0,
        };
        counts.shotCount += 1;
        if (row.status === "ready") counts.readyCount += 1;
        byBoard.set(row.storyboard_id, counts);
      }
      return boards.map((board) => ({
        ...board,
        ...(byBoard.get(board.id) ?? { shotCount: 0, readyCount: 0 }),
      }));
    },

    get: getDetail,

    async getShot(projectId, shotId) {
      try {
        return await requireShot(projectId, shotId);
      } catch (err) {
        if (err instanceof StoryboardNotFoundError) return null;
        throw err;
      }
    },

    async create(projectId, input) {
      assertShots(input);
      const nowIso = new Date().toISOString();
      // 一个项目同时只有一个 active 分镜；新建的分镜成为当前分镜
      const { error: deactivateError } = await db()
        .from("storyboards")
        .update({ active: false, updated_at: nowIso })
        .eq("project_id", projectId)
        .eq("active", true);
      if (deactivateError) throw deactivateError;
      const { data: board, error } = await db()
        .from("storyboards")
        .insert({
          project_id: projectId,
          title: input.title.trim(),
          brief: input.brief.trim(),
          kind: input.kind ?? "image",
          aspect_ratio: input.aspectRatio ?? null,
          style: input.style ?? null,
          canon_asset_id: input.canonAssetId ?? null,
          total_duration_seconds: input.totalDurationSeconds ?? null,
          status: "draft",
          active: true,
        })
        .select(BOARD_COLUMNS)
        .single();
      if (error) throw error;
      const boardId = (board as BoardRow).id;
      const { error: shotError } = await db().from("storyboard_shots").insert(
        input.shots.map((shot, index) => ({
          storyboard_id: boardId,
          order_index: index + 1,
          title: shot.title.trim(),
          description: shot.description ?? "",
          prompt: shot.prompt ?? "",
          duration_seconds: shot.durationSeconds ?? null,
          camera: shot.camera ?? null,
          transition: shot.transition ?? null,
          scene_goal: shot.sceneGoal ?? "",
          continuity_note: shot.continuityNote ?? "",
          negative_prompt: shot.negativePrompt ?? "",
          status: "draft",
        })),
      );
      if (shotError) {
        await db().from("storyboards").delete().eq("id", boardId);
        throw shotError;
      }
      const detail = await requireBoard(projectId, boardId);
      await writeRevision(boardId, "create", snapshotOf(detail));
      return detail;
    },

    async updateStoryboard(projectId, storyboardId, patch) {
      const detail = await requireBoard(projectId, storyboardId);
      const nextKind = patch.kind ?? detail.storyboard.kind;
      if (nextKind === "video") {
        assertVideoTimeline(
          nextKind,
          patch.totalDurationSeconds ?? detail.storyboard.totalDurationSeconds,
          activeShots(detail),
        );
      }
      if (patch.active === true) {
        const { error: deactivateError } = await db()
          .from("storyboards")
          .update({ active: false, updated_at: new Date().toISOString() })
          .eq("project_id", projectId)
          .neq("id", storyboardId)
          .eq("active", true);
        if (deactivateError) throw deactivateError;
      }
      const { error } = await db()
        .from("storyboards")
        .update(boardPatch(patch))
        .eq("id", storyboardId)
        .eq("project_id", projectId);
      if (error) throw error;
      return { ...detail, storyboard: { ...detail.storyboard, ...patch } };
    },

    async updateShot(projectId, shotId, patch) {
      const { storyboard, shot } = await requireShot(projectId, shotId);
      if (
        storyboard.kind === "video" &&
        patch.durationSeconds !== undefined &&
        (patch.durationSeconds < 4 || patch.durationSeconds > 15)
      ) {
        throw new StoryboardValidationError("视频镜头每段必须是 4-15 秒");
      }
      const { data, error } = await db()
        .from("storyboard_shots")
        .update(shotPatch(patch))
        .eq("id", shotId)
        .select(SHOT_COLUMNS)
        .single();
      if (error) throw error;
      return toShot(data as ShotRow);
    },

    async reorder(projectId, storyboardId, orderedShotIds) {
      const detail = await requireBoard(projectId, storyboardId);
      const current = activeShots(detail);
      const currentIds = current.map((shot) => shot.id).sort();
      const nextIds = [...orderedShotIds].sort();
      if (
        currentIds.length !== nextIds.length ||
        currentIds.some((id, index) => id !== nextIds[index])
      ) {
        throw new StoryboardValidationError("镜头列表和当前分镜不一致，请先 get_storyboard");
      }
      await writeRevision(storyboardId, "reorder", snapshotOf(detail));

      // 两阶段写，避免 (storyboard_id, order_index) 唯一约束在交换时冲突
      for (const [index, id] of orderedShotIds.entries()) {
        const { error } = await db()
          .from("storyboard_shots")
          .update({ order_index: -(index + 1), updated_at: new Date().toISOString() })
          .eq("id", id)
          .eq("storyboard_id", storyboardId);
        if (error) throw error;
      }
      for (const [index, id] of orderedShotIds.entries()) {
        const { error } = await db()
          .from("storyboard_shots")
          .update({ order_index: index + 1, updated_at: new Date().toISOString() })
          .eq("id", id)
          .eq("storyboard_id", storyboardId);
        if (error) throw error;
      }
      return requireBoard(projectId, storyboardId);
    },

    async deleteShot(projectId, shotId) {
      const { storyboard } = await requireShot(projectId, shotId);
      const detail = await requireBoard(projectId, storyboard.id);
      await writeRevision(storyboard.id, "delete_shot", snapshotOf(detail));
      const now = new Date().toISOString();
      const { error } = await db()
        .from("storyboard_shots")
        .update({
          deleted_at: now,
          active_asset_id: null,
          first_frame_asset_id: null,
          end_frame_asset_id: null,
          video_asset_id: null,
          video_last_frame_asset_id: null,
          updated_at: now,
        })
        .eq("id", shotId);
      if (error) throw error;
    },

    async resetShot(projectId, shotId) {
      const { shot } = await requireShot(projectId, shotId);
      const { data, error } = await db()
        .from("storyboard_shots")
        .update({
          active_asset_id: null,
          first_frame_asset_id: null,
          end_frame_asset_id: null,
          video_asset_id: null,
          video_last_frame_asset_id: null,
          status: "draft",
          updated_at: new Date().toISOString(),
        })
        .eq("id", shot.id)
        .select(SHOT_COLUMNS)
        .single();
      if (error) throw error;
      return toShot(data as ShotRow);
    },

    async resetStoryboard(projectId, storyboardId) {
      const detail = await requireBoard(projectId, storyboardId);
      await writeRevision(storyboardId, "reset", snapshotOf(detail));
      const now = new Date().toISOString();
      const { error: shotError } = await db()
        .from("storyboard_shots")
        .update({
          active_asset_id: null,
          first_frame_asset_id: null,
          end_frame_asset_id: null,
          video_asset_id: null,
          video_last_frame_asset_id: null,
          status: "draft",
          updated_at: now,
        })
        .eq("storyboard_id", storyboardId)
        .is("deleted_at", null);
      if (shotError) throw shotError;
      const { error } = await db()
        .from("storyboards")
        .update({ status: "draft", updated_at: now })
        .eq("id", storyboardId);
      if (error) throw error;
      return requireBoard(projectId, storyboardId);
    },

    async restoreStoryboard(projectId, storyboardId, revisionId) {
      const current = await requireBoard(projectId, storyboardId);
      const { data: revision, error } = await db()
        .from("storyboard_revisions")
        .select("id, snapshot")
        .eq("storyboard_id", storyboardId)
        .eq("id", revisionId)
        .maybeSingle();
      if (error) throw error;
      if (!revision) throw new StoryboardNotFoundError("分镜版本不存在");
      const snapshot = (revision as { snapshot: StoryboardSnapshot }).snapshot;
      if (!snapshot?.storyboard || !Array.isArray(snapshot.shots)) {
        throw new StoryboardValidationError("分镜版本快照不完整");
      }

      await writeRevision(storyboardId, "restore", snapshotOf(current));
      const now = new Date().toISOString();
      const { error: boardError } = await db()
        .from("storyboards")
        .update({
          title: snapshot.storyboard.title,
          brief: snapshot.storyboard.brief,
          kind: snapshot.storyboard.kind ?? "image",
          aspect_ratio: snapshot.storyboard.aspectRatio ?? null,
          style: snapshot.storyboard.style ?? null,
          canon_asset_id: snapshot.storyboard.canonAssetId ?? null,
          product_detail_anchor_asset_id:
            snapshot.storyboard.productDetailAnchorAssetId ?? null,
          character_anchor_asset_id: snapshot.storyboard.characterAnchorAssetId ?? null,
          scene_anchor_asset_id: snapshot.storyboard.sceneAnchorAssetId ?? null,
          style_anchor_asset_id: snapshot.storyboard.styleAnchorAssetId ?? null,
          total_duration_seconds: snapshot.storyboard.totalDurationSeconds ?? null,
          status: snapshot.storyboard.status,
          active: snapshot.storyboard.active,
          metadata: snapshot.storyboard.metadata ?? {},
          updated_at: now,
        })
        .eq("id", storyboardId)
        .eq("project_id", projectId);
      if (boardError) throw boardError;

      // 先把现有镜头挪到负数，避免恢复时 order_index 撞唯一约束
      for (const [index, shot] of current.shots.entries()) {
        const { error: moveError } = await db()
          .from("storyboard_shots")
          .update({ order_index: -(index + 1), updated_at: now })
          .eq("id", shot.id);
        if (moveError) throw moveError;
      }

      const snapshotIds = new Set(snapshot.shots.map((shot) => shot.id));
      for (const shot of snapshot.shots) {
        const { error: upsertError } = await db().from("storyboard_shots").upsert(
          {
            id: shot.id,
            storyboard_id: storyboardId,
            order_index: shot.orderIndex,
            title: shot.title,
            description: shot.description ?? "",
            prompt: shot.prompt ?? "",
            duration_seconds: shot.durationSeconds ?? null,
            camera: shot.camera ?? null,
            transition: shot.transition ?? null,
            scene_goal: shot.sceneGoal ?? "",
            continuity_note: shot.continuityNote ?? "",
            negative_prompt: shot.negativePrompt ?? "",
            active_asset_id: shot.activeAssetId ?? null,
            first_frame_asset_id: shot.firstFrameAssetId ?? null,
            end_frame_asset_id: shot.endFrameAssetId ?? null,
            video_asset_id: shot.videoAssetId ?? null,
            video_last_frame_asset_id: shot.videoLastFrameAssetId ?? null,
            status: shot.status,
            metadata: shot.metadata ?? {},
            deleted_at: shot.deletedAt ?? null,
            updated_at: now,
          },
          { onConflict: "id" },
        );
        if (upsertError) throw upsertError;
      }
      for (const shot of current.shots) {
        if (snapshotIds.has(shot.id)) continue;
        const { error: deleteError } = await db()
          .from("storyboard_shots")
          .update({ deleted_at: now, updated_at: now })
          .eq("id", shot.id);
        if (deleteError) throw deleteError;
      }
      return requireBoard(projectId, storyboardId);
    },

    async setShotAsset(projectId, shotId, assetId) {
      await requireShot(projectId, shotId);
      let pointer: "first" | "end" | "video" | "last" = "first";
      if (assetId) {
        const asset = await (await getAssetsRepository()).get(projectId, assetId);
        if (!asset) throw new StoryboardValidationError("资产不属于这个项目");
        if (asset.shotId && asset.shotId !== shotId) {
          throw new StoryboardValidationError("这个资产属于另一个镜头");
        }
        pointer =
          asset.kind === "video"
            ? "video"
            : asset.metadata?.role === "end_frame"
              ? "end"
              : asset.metadata?.role === "video_last_frame"
                ? "last"
                : "first";
      }
      const now = new Date().toISOString();
      const value: Record<string, unknown> = {
        active_asset_id: assetId,
        status: assetId ? "ready" : "draft",
        updated_at: now,
      };
      if (pointer === "first") {
        value.first_frame_asset_id = assetId;
        value.end_frame_asset_id = null;
        value.video_asset_id = null;
      } else if (pointer === "end") {
        value.end_frame_asset_id = assetId;
      } else if (pointer === "last") {
        value.video_last_frame_asset_id = assetId;
      } else {
        value.video_asset_id = assetId;
      }
      const { data, error } = await db()
        .from("storyboard_shots")
        .update(value)
        .eq("id", shotId)
        .select(SHOT_COLUMNS)
        .single();
      if (error) throw error;
      return toShot(data as ShotRow);
    },

    async setCanonAsset(projectId, storyboardId, assetId) {
      return this.setAnchorAsset(projectId, storyboardId, "product", assetId);
    },

    async setAnchorAsset(projectId, storyboardId, anchorType, assetId) {
      await requireBoard(projectId, storyboardId);
      if (assetId) {
        const asset = await (await getAssetsRepository()).get(projectId, assetId);
        if (!asset || asset.kind !== "image") {
          throw new StoryboardValidationError("锚图必须是这个项目里的图片资产");
        }
      }
      const column =
        anchorType === "product"
          ? "canon_asset_id"
          : anchorType === "product_detail"
            ? "product_detail_anchor_asset_id"
            : anchorType === "character"
            ? "character_anchor_asset_id"
            : anchorType === "scene"
              ? "scene_anchor_asset_id"
              : "style_anchor_asset_id";
      const { data, error } = await db()
        .from("storyboards")
        .update({ [column]: assetId, updated_at: new Date().toISOString() })
        .eq("id", storyboardId)
        .eq("project_id", projectId)
        .select(BOARD_COLUMNS)
        .single();
      if (error) throw error;
      return toBoard(data as BoardRow);
    },

    async applyFirstFrame(projectId, shotId, assetId) {
      await requireShot(projectId, shotId);
      const { error } = await db()
        .from("storyboard_shots")
        .update({
          active_asset_id: assetId,
          first_frame_asset_id: assetId,
          status: "ready",
          updated_at: new Date().toISOString(),
        })
        .eq("id", shotId);
      if (error) throw error;
    },

    async applyEndFrame(projectId, shotId, assetId) {
      await requireShot(projectId, shotId);
      const { error } = await db()
        .from("storyboard_shots")
        .update({
          end_frame_asset_id: assetId,
          status: "ready",
          updated_at: new Date().toISOString(),
        })
        .eq("id", shotId);
      if (error) throw error;
    },

    async applyVideo(projectId, shotId, assetId) {
      await requireShot(projectId, shotId);
      const { error } = await db()
        .from("storyboard_shots")
        .update({
          video_asset_id: assetId,
          video_last_frame_asset_id: null,
          status: "ready",
          updated_at: new Date().toISOString(),
        })
        .eq("id", shotId);
      if (error) throw error;
    },

    async applyVideoLastFrame(projectId, shotId, assetId) {
      await requireShot(projectId, shotId);
      const { error } = await db()
        .from("storyboard_shots")
        .update({
          video_last_frame_asset_id: assetId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", shotId);
      if (error) throw error;
    },

    async listRevisions(projectId, storyboardId, limit = 10) {
      await requireBoard(projectId, storyboardId);
      const { data, error } = await db()
        .from("storyboard_revisions")
        .select("id, reason, created_at")
        .eq("storyboard_id", storyboardId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as { id: string; reason: string; created_at: string }[]).map(
        (row) => ({ id: row.id, reason: row.reason, createdAt: row.created_at }),
      );
    },
  };
}

// ---------------------------------------------------------------- memory fallback

type MemoryBoard = { detail: StoryboardDetail; revisions: StoryboardRevision[] };

function createMemoryStoryboardsRepository(): StoryboardsRepository {
  const store = new Map<string, Map<string, MemoryBoard>>();
  const boards = (projectId: string) => {
    let map = store.get(projectId);
    if (!map) {
      map = new Map();
      store.set(projectId, map);
    }
    return map;
  };

  function require(projectId: string, storyboardId: string): MemoryBoard {
    const board = boards(projectId).get(storyboardId);
    if (!board) throw new StoryboardNotFoundError();
    return board;
  }

  function findShot(projectId: string, shotId: string) {
    for (const [storyboardId, board] of boards(projectId)) {
      const shot = board.detail.shots.find((item) => item.id === shotId);
      if (shot) return { storyboardId, board, shot };
    }
    return null;
  }

  function revision(board: MemoryBoard, reason: string): void {
    board.revisions.push({
      id: randomUUID(),
      storyboardId: board.detail.storyboard.id,
      reason,
      snapshot: snapshotOf(board.detail) as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    async list(projectId) {
      return [...boards(projectId).values()]
        .map(({ detail }) => ({
          ...detail.storyboard,
          ...shotCounts(detail.shots),
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async get(projectId, storyboardId) {
      return boards(projectId).get(storyboardId)?.detail ?? null;
    },
    async getShot(projectId, shotId) {
      const found = findShot(projectId, shotId);
      return found ? { storyboard: found.board.detail.storyboard, shot: found.shot } : null;
    },
    async create(projectId, input) {
      assertShots(input);
      for (const board of boards(projectId).values()) {
        board.detail.storyboard.active = false;
      }
      const now = new Date().toISOString();
      const board: Storyboard = {
        id: randomUUID(),
        projectId,
        title: input.title.trim(),
        brief: input.brief.trim(),
        kind: input.kind ?? "image",
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.style ? { style: input.style } : {}),
        ...(input.canonAssetId ? { canonAssetId: input.canonAssetId } : {}),
        ...(input.totalDurationSeconds
          ? { totalDurationSeconds: input.totalDurationSeconds }
          : {}),
        status: "draft",
        active: true,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      };
      const detail: StoryboardDetail = {
        storyboard: board,
        shots: input.shots.map((shot, index) => ({
          id: randomUUID(),
          storyboardId: board.id,
          orderIndex: index + 1,
          title: shot.title.trim(),
          description: shot.description ?? "",
          prompt: shot.prompt ?? "",
          ...(shot.durationSeconds ? { durationSeconds: shot.durationSeconds } : {}),
          ...(shot.camera ? { camera: shot.camera } : {}),
          ...(shot.transition ? { transition: shot.transition } : {}),
          ...(shot.sceneGoal ? { sceneGoal: shot.sceneGoal } : {}),
          ...(shot.continuityNote ? { continuityNote: shot.continuityNote } : {}),
          ...(shot.negativePrompt ? { negativePrompt: shot.negativePrompt } : {}),
          status: "draft",
          metadata: {},
          createdAt: now,
          updatedAt: now,
        })),
      };
      const entry: MemoryBoard = { detail, revisions: [] };
      revision(entry, "create");
      boards(projectId).set(board.id, entry);
      return detail;
    },
    async updateStoryboard(projectId, storyboardId, patch) {
      const board = require(projectId, storyboardId);
      if (patch.active === true) {
        for (const item of boards(projectId).values()) {
          if (item.detail.storyboard.id !== storyboardId) {
            item.detail.storyboard.active = false;
          }
        }
      }
      board.detail.storyboard = {
        ...board.detail.storyboard,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      return board.detail;
    },
    async updateShot(projectId, shotId, patch) {
      const found = findShot(projectId, shotId);
      if (!found) throw new StoryboardNotFoundError("镜头不存在");
      found.shot = { ...found.shot, ...patch, updatedAt: new Date().toISOString() };
      found.board.detail.shots = found.board.detail.shots.map((shot) =>
        shot.id === shotId ? found.shot : shot,
      );
      return found.shot;
    },
    async reorder(projectId, storyboardId, orderedShotIds) {
      const board = require(projectId, storyboardId);
      const current = activeShots(board.detail).map((shot) => shot.id).sort();
      const next = [...orderedShotIds].sort();
      if (current.length !== next.length || current.some((id, i) => id !== next[i])) {
        throw new StoryboardValidationError("镜头列表和当前分镜不一致，请先 get_storyboard");
      }
      revision(board, "reorder");
      board.detail.shots = board.detail.shots.map((shot) => {
        const index = orderedShotIds.indexOf(shot.id);
        return index < 0 ? shot : { ...shot, orderIndex: index + 1 };
      });
      return board.detail;
    },
    async deleteShot(projectId, shotId) {
      const found = findShot(projectId, shotId);
      if (!found) throw new StoryboardNotFoundError("镜头不存在");
      revision(found.board, "delete_shot");
      found.shot = {
        ...found.shot,
        deletedAt: new Date().toISOString(),
        activeAssetId: undefined,
        firstFrameAssetId: undefined,
        endFrameAssetId: undefined,
        videoAssetId: undefined,
        videoLastFrameAssetId: undefined,
        updatedAt: new Date().toISOString(),
      };
      found.board.detail.shots = found.board.detail.shots.map((shot) =>
        shot.id === shotId ? found.shot : shot,
      );
    },
    async resetShot(projectId, shotId) {
      return this.updateShot(projectId, shotId, { status: "draft" }).then((shot) => {
        const found = findShot(projectId, shotId);
        if (found) {
          found.shot = {
            ...found.shot,
            activeAssetId: undefined,
            firstFrameAssetId: undefined,
            endFrameAssetId: undefined,
            videoAssetId: undefined,
          };
          found.board.detail.shots = found.board.detail.shots.map((item) =>
            item.id === shotId ? found.shot : item,
          );
        }
        return found?.shot ?? shot;
      });
    },
    async resetStoryboard(projectId, storyboardId) {
      const board = require(projectId, storyboardId);
      revision(board, "reset");
      board.detail.storyboard = {
        ...board.detail.storyboard,
        status: "draft",
        updatedAt: new Date().toISOString(),
      };
      board.detail.shots = board.detail.shots.map((shot) => ({
        ...shot,
        activeAssetId: undefined,
        firstFrameAssetId: undefined,
        endFrameAssetId: undefined,
        videoAssetId: undefined,
        videoLastFrameAssetId: undefined,
        status: "draft",
      }));
      return board.detail;
    },
    async restoreStoryboard(projectId, storyboardId, revisionId) {
      const board = require(projectId, storyboardId);
      const rev = board.revisions.find((item) => item.id === revisionId);
      if (!rev) throw new StoryboardNotFoundError("分镜版本不存在");
      const snapshot = rev.snapshot as unknown as StoryboardSnapshot;
      revision(board, "restore");
      board.detail = {
        storyboard: { ...snapshot.storyboard, updatedAt: new Date().toISOString() },
        shots: snapshot.shots.map((shot) => ({ ...shot })),
      };
      return board.detail;
    },
    async setShotAsset(projectId, shotId, assetId) {
      let pointer: "first" | "end" | "video" | "last" = "first";
      if (assetId) {
        const asset = await (await getAssetsRepository()).get(projectId, assetId);
        if (!asset) throw new StoryboardValidationError("资产不属于这个项目");
        pointer =
          asset.kind === "video"
            ? "video"
            : asset.metadata?.role === "end_frame"
              ? "end"
              : asset.metadata?.role === "video_last_frame"
                ? "last"
                : "first";
      }
      return this.updateShot(projectId, shotId, {
        status: assetId ? "ready" : "draft",
      }).then((shot) => {
        const found = findShot(projectId, shotId);
        if (found) {
          found.shot = {
            ...found.shot,
            activeAssetId: assetId ?? undefined,
            ...(pointer === "first"
              ? {
                  firstFrameAssetId: assetId ?? undefined,
                  endFrameAssetId: undefined,
                  videoAssetId: undefined,
                }
              : {}),
            ...(pointer === "end" ? { endFrameAssetId: assetId ?? undefined } : {}),
            ...(pointer === "last"
              ? { videoLastFrameAssetId: assetId ?? undefined }
              : {}),
            ...(pointer === "video" ? { videoAssetId: assetId ?? undefined } : {}),
          };
          found.board.detail.shots = found.board.detail.shots.map((item) =>
            item.id === shotId ? found.shot : item,
          );
        }
        return found?.shot ?? shot;
      });
    },
    async setCanonAsset(projectId, storyboardId, assetId) {
      return this.setAnchorAsset(projectId, storyboardId, "product", assetId);
    },
    async setAnchorAsset(projectId, storyboardId, anchorType, assetId) {
      const board = require(projectId, storyboardId);
      if (assetId) {
        const asset = await (await getAssetsRepository()).get(projectId, assetId);
        if (!asset || asset.kind !== "image") {
          throw new StoryboardValidationError("锚图必须是这个项目里的图片资产");
        }
      }
      const key =
        anchorType === "product"
          ? "canonAssetId"
          : anchorType === "product_detail"
            ? "productDetailAnchorAssetId"
            : anchorType === "character"
            ? "characterAnchorAssetId"
            : anchorType === "scene"
              ? "sceneAnchorAssetId"
              : "styleAnchorAssetId";
      board.detail.storyboard = {
        ...board.detail.storyboard,
        [key]: assetId ?? undefined,
        updatedAt: new Date().toISOString(),
      };
      return board.detail.storyboard;
    },
    async applyFirstFrame(projectId, shotId, assetId) {
      await this.setShotAsset(projectId, shotId, assetId);
    },
    async applyEndFrame(projectId, shotId, assetId) {
      const found = findShot(projectId, shotId);
      if (!found) throw new StoryboardNotFoundError("镜头不存在");
      found.shot = { ...found.shot, endFrameAssetId: assetId, status: "ready" };
      found.board.detail.shots = found.board.detail.shots.map((item) =>
        item.id === shotId ? found.shot : item,
      );
    },
    async applyVideo(projectId, shotId, assetId) {
      const found = findShot(projectId, shotId);
      if (!found) throw new StoryboardNotFoundError("镜头不存在");
      found.shot = {
        ...found.shot,
        videoAssetId: assetId,
        videoLastFrameAssetId: undefined,
        status: "ready",
      };
      found.board.detail.shots = found.board.detail.shots.map((item) =>
        item.id === shotId ? found.shot : item,
      );
    },
    async applyVideoLastFrame(projectId, shotId, assetId) {
      const found = findShot(projectId, shotId);
      if (!found) throw new StoryboardNotFoundError("镜头不存在");
      found.shot = { ...found.shot, videoLastFrameAssetId: assetId };
      found.board.detail.shots = found.board.detail.shots.map((item) =>
        item.id === shotId ? found.shot : item,
      );
    },
    async listRevisions(projectId, storyboardId, limit = 10) {
      const board = require(projectId, storyboardId);
      return board.revisions
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((item) => ({ id: item.id, reason: item.reason, createdAt: item.createdAt }));
    },
  };
}

let repository: Promise<StoryboardsRepository> | null = null;
let warned = false;

export function getStoryboardsRepository(): Promise<StoryboardsRepository> {
  if (env.projectsStore !== "supabase") {
    return Promise.resolve(createMemoryStoryboardsRepository());
  }
  if (repository) return repository;
  repository = (async () => {
    try {
      const { error } = await getDb().from("storyboards").select("id").limit(1);
      if (error) {
        if (!warned) {
          warned = true;
          console.warn(
            "[storyboards] 分镜未启用：请先执行 supabase/migrations/0009_storyboards.sql",
          );
        }
        return createMemoryStoryboardsRepository();
      }
      return createSupabaseStoryboardsRepository();
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn("[storyboards] 分镜初始化失败，回落到内存：", err);
      }
      return createMemoryStoryboardsRepository();
    }
  })();
  return repository;
}