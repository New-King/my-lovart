export type StoryboardStatus = "draft" | "ready" | "generating" | "completed";
export type ShotStatus = "draft" | "generating" | "ready" | "failed";
/** image = 视觉分镜/概念；video = 可执行视频时间线 */
export type StoryboardKind = "image" | "video";

export type Storyboard = {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  kind: StoryboardKind;
  aspectRatio?: string;
  style?: string;
  /** 产品/角色/视觉设定图：后续所有关键帧的共享参考；null 表示显式清空 */
  canonAssetId?: string | null;
  /** 视频总时长；kind=video 时必填 */
  totalDurationSeconds?: number;
  status: StoryboardStatus;
  active: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type StoryboardShot = {
  id: string;
  storyboardId: string;
  orderIndex: number;
  title: string;
  description: string;
  prompt: string;
  durationSeconds?: number;
  camera?: string;
  transition?: string;
  /** 旧字段：兼容旧数据；新代码按 firstFrame/video 读写 */
  activeAssetId?: string;
  firstFrameAssetId?: string;
  endFrameAssetId?: string;
  videoAssetId?: string;
  status: ShotStatus;
  metadata: Record<string, unknown>;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type StoryboardDetail = {
  storyboard: Storyboard;
  shots: StoryboardShot[];
};

export type StoryboardSummary = Storyboard & {
  shotCount: number;
  readyCount: number;
};

export type StoryboardRevision = {
  id: string;
  storyboardId: string;
  reason: string;
  snapshot: Record<string, unknown>;
  createdAt: string;
};

export type StoryboardShotInput = {
  title: string;
  description?: string;
  prompt?: string;
  durationSeconds?: number;
  camera?: string;
  transition?: string;
};

export type CreateStoryboardInput = {
  title: string;
  brief: string;
  kind?: StoryboardKind;
  aspectRatio?: string;
  style?: string;
  canonAssetId?: string;
  totalDurationSeconds?: number;
  shots: StoryboardShotInput[];
};

export type UpdateStoryboardInput = {
  title?: string;
  brief?: string;
  kind?: StoryboardKind;
  aspectRatio?: string;
  style?: string;
  canonAssetId?: string | null;
  totalDurationSeconds?: number;
  status?: StoryboardStatus;
  active?: boolean;
};

export type UpdateShotInput = {
  title?: string;
  description?: string;
  prompt?: string;
  durationSeconds?: number;
  camera?: string;
  transition?: string;
  status?: ShotStatus;
};

export type StoryboardSnapshot = {
  storyboard: Storyboard;
  shots: StoryboardShot[];
};

/** 稳定、可回放的快照：只存恢复需要的字段，不含派生计数 */
export function snapshotOf(detail: StoryboardDetail): StoryboardSnapshot {
  return {
    storyboard: { ...detail.storyboard },
    shots: detail.shots.map((shot) => ({ ...shot })),
  };
}

export function activeShots(detail: StoryboardDetail): StoryboardShot[] {
  return detail.shots
    .filter((shot) => !shot.deletedAt)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export function shotCounts(shots: StoryboardShot[]): {
  shotCount: number;
  readyCount: number;
} {
  const visible = shots.filter((shot) => !shot.deletedAt);
  return {
    shotCount: visible.length,
    readyCount: visible.filter((shot) => shot.status === "ready").length,
  };
}