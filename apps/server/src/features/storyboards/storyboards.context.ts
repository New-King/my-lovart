import type {
  StoryboardDetail,
  StoryboardSummary,
} from "./storyboards.js";

const MAX_BOARDS = 8;
const MAX_DESCRIPTION = 180;
const MAX_XML_CHARS = 6_000;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function clip(value: string, max = MAX_DESCRIPTION): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export type ProjectStateContext = {
  xml: string;
  summary: string;
  storyboardCount: number;
  activeStoryboardId?: string;
};

/**
 * <project_state>：只展开当前 active 分镜的镜头列表；
 * 其他分镜各一行，避免上下文被多个分镜撑爆。
 */
export function buildProjectStateContext(
  boards: StoryboardSummary[],
  active: StoryboardDetail | null,
): ProjectStateContext {
  if (boards.length === 0) {
    return { xml: "", summary: "", storyboardCount: 0 };
  }

  const visibleBoards = boards.slice(0, MAX_BOARDS);
  const activeId = active?.storyboard.id ?? visibleBoards.find((b) => b.active)?.id;
  const lines: string[] = [];
  const others: string[] = [];

  for (const board of visibleBoards) {
    if (active && board.id === active.storyboard.id) continue;
    others.push(
      `  <storyboard id="${escapeXml(board.id)}" title="${escapeXml(clip(board.title, 60))}" kind="${board.kind}" status="${board.status}" shots="${board.shotCount}" active="${board.active}"${
        board.aspectRatio ? ` aspect="${escapeXml(board.aspectRatio)}"` : ""
      }${board.totalDurationSeconds ? ` duration="${board.totalDurationSeconds}"` : ""}${
        board.canonAssetId ? ` product_anchor_id="${escapeXml(board.canonAssetId)}"` : ""
      }${board.characterAnchorAssetId ? ` character_anchor_id="${escapeXml(board.characterAnchorAssetId)}"` : ""}${
        board.sceneAnchorAssetId ? ` scene_anchor_id="${escapeXml(board.sceneAnchorAssetId)}"` : ""
      }${board.styleAnchorAssetId ? ` style_anchor_id="${escapeXml(board.styleAnchorAssetId)}"` : ""}/>`,
    );
  }

  if (active) {
    const board = active.storyboard;
    const shots = active.shots
      .filter((shot) => !shot.deletedAt)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const shotLines = shots.map(
      (shot) =>
        `    <shot id="${escapeXml(shot.id)}" order="${shot.orderIndex}" title="${escapeXml(clip(shot.title, 60))}" status="${shot.status}"${
          shot.firstFrameAssetId
            ? ` first_frame_id="${escapeXml(shot.firstFrameAssetId)}"`
            : shot.activeAssetId
              ? ` asset_id="${escapeXml(shot.activeAssetId)}"`
              : ""
        }${shot.endFrameAssetId ? ` end_frame_id="${escapeXml(shot.endFrameAssetId)}"` : ""}${
          shot.videoAssetId ? ` video_id="${escapeXml(shot.videoAssetId)}"` : ""
        }${shot.durationSeconds ? ` duration="${shot.durationSeconds}"` : ""}${
          shot.camera ? ` camera="${escapeXml(clip(shot.camera, 40))}"` : ""
        }${shot.sceneGoal ? ` goal="${escapeXml(clip(shot.sceneGoal, 40))}"` : ""}>${escapeXml(clip(shot.description || shot.prompt))}</shot>`,
    );
    lines.push(
      `  <storyboard id="${escapeXml(board.id)}" title="${escapeXml(clip(board.title, 60))}" kind="${board.kind}" aspect="${escapeXml(board.aspectRatio ?? "")}" status="${board.status}" active="${board.active}" shots="${shots.length}"${
        board.totalDurationSeconds ? ` duration="${board.totalDurationSeconds}"` : ""
      }${board.canonAssetId ? ` product_anchor_id="${escapeXml(board.canonAssetId)}"` : ""}${
        board.characterAnchorAssetId
          ? ` character_anchor_id="${escapeXml(board.characterAnchorAssetId)}"`
          : ""
      }${board.sceneAnchorAssetId ? ` scene_anchor_id="${escapeXml(board.sceneAnchorAssetId)}"` : ""}${
        board.styleAnchorAssetId ? ` style_anchor_id="${escapeXml(board.styleAnchorAssetId)}"` : ""
      }>`,
      ...shotLines,
      "  </storyboard>",
    );
  }

  let xml = `<project_state count="${boards.length}"${
    activeId ? ` active_storyboard_id="${escapeXml(activeId)}"` : ""
  }>\n${[...lines, ...others].join("\n")}\n</project_state>`;

  if (xml.length > MAX_XML_CHARS) {
    xml = `${xml.slice(0, MAX_XML_CHARS)}\n</project_state>`;
  }

  const summary = active
    ? `${active.storyboard.kind === "video" ? "视频分镜" : "分镜"}「${active.storyboard.title}」${activeShots(active)} 个镜头${active.storyboard.totalDurationSeconds ? ` / ${active.storyboard.totalDurationSeconds} 秒` : ""}`
    : `项目有 ${boards.length} 个分镜`;

  return {
    xml,
    summary,
    storyboardCount: boards.length,
    ...(activeId ? { activeStoryboardId: activeId } : {}),
  };
}

function activeShots(detail: StoryboardDetail): number {
  return detail.shots.filter((shot) => !shot.deletedAt).length;
}