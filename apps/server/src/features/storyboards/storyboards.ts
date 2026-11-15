export type StoryboardStatus = "draft" | "ready" | "generating" | "completed";
export type ShotStatus = "draft" | "generating" | "ready" | "failed";

export type Storyboard = {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  aspectRatio?: string;
  style?: string;
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
  activeAssetId?: string;
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
  aspectRatio?: string;
  style?: string;
  shots: StoryboardShotInput[];
};

export type UpdateStoryboardInput = {
  title?: string;
  brief?: string;
  aspectRatio?: string;
  style?: string;
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