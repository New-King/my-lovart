export type StoryboardStatus = "draft" | "ready" | "generating" | "completed";
export type ShotStatus = "draft" | "generating" | "ready" | "failed";
/** image = 视觉分镜/概念；video = 可执行视频时间线 */
export type StoryboardKind = "image" | "video";
/** 执行锚图类型：产品主体、角色、场景、主视觉/色调 */
export type AnchorType = "product" | "character" | "scene" | "style";

export type Storyboard = {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  kind: StoryboardKind;
  aspectRatio?: string;
  style?: string;
  /** 产品锚图（原 canon）：整条片子的产品身份基准 */
  canonAssetId?: string | null;
  characterAnchorAssetId?: string | null;
  sceneAnchorAssetId?: string | null;
  styleAnchorAssetId?: string | null;
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
  /** 这一镜在片子里负责什么：开场建立/卖点强调/承接/收尾 */
  sceneGoal?: string;
  /** 与前后镜的衔接：承接什么、留下什么状态 */
  continuityNote?: string;
  /** 这一镜不允许出现的跑偏内容 */
  negativePrompt?: string;
  /** 旧字段：兼容旧数据；新代码按 firstFrame/video 读写 */
  activeAssetId?: string;
  firstFrameAssetId?: string;
  endFrameAssetId?: string;
  videoAssetId?: string;
  /** 视频实际最后一帧；下一镜承接它，而不是另一张生成的尾帧 */
  videoLastFrameAssetId?: string;
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
  /** 这一镜在片子里负责什么：开场建立/卖点强调/承接/收尾 */
  sceneGoal?: string;
  /** 与前后镜的衔接：承接什么、留下什么状态 */
  continuityNote?: string;
  /** 这一镜不允许出现的跑偏内容 */
  negativePrompt?: string;
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
  /** 这一镜在片子里负责什么：开场建立/卖点强调/承接/收尾 */
  sceneGoal?: string;
  /** 与前后镜的衔接：承接什么、留下什么状态 */
  continuityNote?: string;
  /** 这一镜不允许出现的跑偏内容 */
  negativePrompt?: string;
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