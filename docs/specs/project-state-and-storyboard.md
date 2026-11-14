# 项目状态、产物账本与分镜 · 设计

> 状态：提案（Proposed）  
> 最后更新：2026-11-14  
> 关联：`ROADMAP.md`、`docs/specs/golden-scenarios.md`

## 结论先行

当前实现**没有设计好**这一层，具体表现是：

- 发给模型的历史只有 `{ role, content }`，也就是助手当时说过的正文；
- 生成图片的 `title`、完整 prompt、模型、尺寸、来源参考图、版本关系，基本都没有进入下一轮上下文；
- `ImageBlock` 里虽然有 `prompt`（被截断到 200 字）和 `model`，但它们只用于持久化和界面渲染，**不会**被重建进模型历史；
- 画布摘要里的图片“名字”其实是把 prompt 当成 `customData.name` 用，只解决“这张图大概是什么”的一点点信息，且图片被删除/未上画布后就彻底丢失；
- 工具调用与工具返回只在**同一次 run 内**对模型可见，run 结束后不会回放；
- 系统提示词里没有任何项目资产或分镜状态。

所以现在能做“生成一张图、下一轮继续聊”，但做不了可靠的分镜修改、重置、版本回退、指定第 3 个镜头重做。

Lavart 的做法是 **LangGraph PostgresSaver checkpointer + thread_id**：下一轮只发一条新的用户消息，LangGraph 从 checkpoint 恢复完整消息历史（含 AI tool_calls 与 ToolMessage），因此 `generate_image` 返回的 `title / imageUrl / elementId / placement` 等字段还在。它把 `title` 也写进画布元素的 `customData.title`，并每轮注入画布摘要。但它同样没有显式的分镜/镜头/版本模型，复杂分镜仍然会退化成一长串自然语言。

我们要做的不止对齐 Lavart，而是三层分离：

1. **执行记忆**：checkpointer + `thread_id`，保证工具调用、失败、重试、跨进程恢复。
2. **项目状态**：资产账本 + 分镜/镜头 + 版本，结构化、可查询、可回退。
3. **展示历史**：`chat_messages` 只负责界面显示，不再是模型的唯一事实来源。

## 1. 现状审计

| 数据 | 当前存放 | 下一轮是否进入模型 | 具体字段/位置 |
| --- | --- | --- | --- |
| 用户文字 | `messages.content` | 是 | `history` 里的 `role + content` |
| 助手正文 | `messages.content` | 是 | 同上，最多 20 条 |
| 生成图片 URL/尺寸 | `messages.blocks` / `parts` 的 `ImageBlock` | **否**（只有画布仍存在时，名字以 prompt 形式出现） | `workspace.service.ts` 的 `history` 只取 `content` |
| 图片标题 | 没有存进 artifact | **否** | `generate_image` 的 tool 结果没有 title 字段 |
| 完整 prompt | `ImageBlock.prompt` 截断 200 字 | **否** | 只用于界面/持久化 |
| 模型、比例 | `ImageBlock.model/aspectRatio` | **否** | 同上 |
| 参考图血缘 | 没有 | **否** | 工具调用结束即丢 |
| 工具调用/结果 | LangGraph 单次运行状态 | 仅当前 run | run 结束不持久 |
| 画布元素 | `canvases.elements` | 是（摘要） | `buildCanvasContext`，图片名来自 `customData.name` |
| 画布图片的真实资产 id | 没有 | 否 | 只有 `canvas-1` 这类临时别名 |
| 分镜/镜头 | 没有数据模型 | 否 | 完全不存在 |

### 为什么画布摘要是“半个补丁”

前端在自动上画布时执行 `name: block.prompt || "生成图像"`，于是 prompt 被塞进 `customData.name`，下一轮 `buildCanvasContext` 把它读出来。这带来三个问题：

- 标题和 prompt 混为一谈，200 字截断，模型分不清“标题”和“生成提示词”；
- 用户没把图放进画布、删除了图、或图片在 60 个元素上限之外，信息就没了；
- 没有资产 id，模型无法可靠地说“把第 3 张图的 v2 再做一版”，只能猜画布位置。

## 2. Lavart 对比

Lavart 相关实现：

- `agent/runtime.ts`：每轮只构造一条 `HumanMessage`，`configurable.thread_id` 交给 checkpointer；没有手工 `history` 数组。
- `agent/persistence/supabase-checkpointer.ts`：`PostgresSaver` + 独立 schema `langgraph`。
- `agent/tools/image-generate.ts`：工具结果包含 `title`、`imageUrl`、`elementId`、`width/height`、`placement`；这些进入 ToolMessage，随后被 checkpoint 保存。
- `canvas-element-writer.ts`：把 `title` 写进元素 `customData.title`。
- `inspect-canvas.ts`：每轮注入画布摘要，支持 summary/full。
- `project_search.ts`：搜索 sandbox workspace 文件，而不是资产账本。

结论：Lavart 解决了“工具产物元数据跨轮还在”的问题，靠的是 checkpoint 而不是显式资产表；它没有分镜 schema、镜头版本、重置语义。我们要在它之上补这一层。

## 3. 数据模型

### 3.1 `project_assets`（不可变产物账本）

一行代表一次生成/上传产生的**具体文件**，不覆盖、不原地改。

```sql
create table project_assets (
  id uuid primary key,                 -- 复用 artifact.id，稳定
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check (kind in ('image','video')),
  origin text not null check (origin in ('generated','uploaded','derived')),
  title text not null,
  prompt text not null,
  model text,
  provider text,
  url text not null,
  mime_type text,
  width int,
  height int,
  duration_seconds numeric,
  aspect_ratio text,
  parent_asset_id uuid references project_assets(id) on delete set null,
  source_asset_ids jsonb not null default '[]'::jsonb,
  canvas_element_id text,
  message_id uuid,
  shot_id uuid references storyboard_shots(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

关键点：

- `id` 就是 artifact id，不是画布 `elementId`；两者都要保留，不能混用。
- `source_asset_ids` 记录图生图/首尾帧引用了哪些资产；`parent_asset_id` 表示“由哪张图改出来”。
- `shot_id` 让资产可以挂到分镜镜头上；一个镜头可以有多版资产，只有一版是 active。
- 旧资产永不删除；“重置”只是把镜头的 active 指针清空或改指向。

### 3.2 `storyboards` / `storyboard_shots`

```sql
create table storyboards (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  brief text not null default '',
  aspect_ratio text,
  style text,
  status text not null default 'draft',  -- draft/ready/generating/completed
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table storyboard_shots (
  id uuid primary key,
  storyboard_id uuid not null references storyboards(id) on delete cascade,
  order_index int not null,
  title text not null,
  description text not null default '',
  prompt text not null default '',
  duration_seconds numeric,
  camera text,
  transition text,
  active_asset_id uuid references project_assets(id) on delete set null,
  status text not null default 'draft',  -- draft/generating/ready/failed
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storyboard_id, order_index)
);
```

### 3.3 `storyboard_revisions`（重置/撤销的底座）

每次对分镜做结构性修改（增删镜头、改顺序、批量改 prompt、重置）写一条不可变快照：

```sql
create table storyboard_revisions (
  id uuid primary key,
  storyboard_id uuid not null references storyboards(id) on delete cascade,
  reason text not null,       -- create/update_shot/reorder/reset/restore
  snapshot jsonb not null,    -- 整个 storyboard + shots 的 JSON
  created_at timestamptz not null default now()
);
```

“重置分镜”= 写 revision + 清空各 shot 的 `active_asset_id` + 状态回到 draft；旧资产仍在 `project_assets`，可随时 `set_shot_asset` 恢复某一版。

## 4. 上下文契约

每轮注入的顺序固定为：

1. 用户本轮输入
2. `<canvas_state>`（现有摘要，最多 30 个元素）
3. `<canvas_images>`（可见图片，带 `canvas_alias` 与真实 `asset_id`）
4. `<project_state>`（分镜/镜头，当前分镜展开；其他分镜只给一行）
5. `<project_assets>`（最近 12 个资产：id、kind、title、prompt 摘要 240 字、model、尺寸、shot_id）
6. `<input_images>`（本轮/最近附件）

示例：

```xml
<project_state count="1">
  <storyboard id="sb_1" title="30 秒咖啡广告" aspect="9:16" status="draft" active="true" shots="6">
    <shot id="sh_1" order="1" title="清晨咖啡杯" status="ready" asset_id="as_1" duration="3">窗边逆光，杯中热气上升</shot>
    <shot id="sh_2" order="2" title="手冲特写" status="draft" duration="4">手部动作，浅景深</shot>
  </storyboard>
</project_state>

<project_assets count="12">
  <asset id="as_1" kind="image" title="清晨咖啡杯 v1" model="Seedream 5.0" size="1024x1536" shot_id="sh_1">暖色晨光，窗边咖啡杯，热气…</asset>
</project_assets>
```

规则：

- `asset_id` / `shot_id` / `storyboard_id` 是稳定 id；画布的 `canvas-1` 只是别名，提示词里要说明两者不同。
- 摘要里放“足够判断”的信息，完整 prompt/血缘通过 `get_asset` / `get_storyboard` 查，避免上下文膨胀。
- 预算：`project_state` ≤ 1500 tokens，`project_assets` ≤ 1500 tokens，`canvas_state` ≤ 1500 tokens；超出先截断历史旧消息，再截断资产摘要，**不删当前分镜的 shot 列表**。
- 没有分镜时，`<project_state>` 不注入；没有资产时，`<project_assets>` 不注入，避免“画布/项目为空”的废话。
- 历史策略：有 checkpointer 时，模型消息由 checkpoint 恢复；手工 `history` 只作为无 checkpoint 的降级。两者只能选一个，不能同时拼，否则会重复。

## 5. 工具契约

新增工具（名称即协议）：

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `list_assets` | 按标题/prompt/kind/分镜筛选资产 | `query? kind? storyboard_id? shot_id? limit?` |
| `get_asset` | 取完整 prompt、血缘、版本 | `asset_id` |
| `list_storyboards` | 分镜列表/摘要 | — |
| `get_storyboard` | 取分镜 + 全部镜头 + 每镜头资产版本 | `storyboard_id` |
| `create_storyboard` | 建分镜 + 镜头草稿 | `title brief shots[] aspect style` |
| `update_storyboard` | 改标题/风格/画幅/状态 | `storyboard_id patch` |
| `update_shot` | 改单个镜头的文字/时长/机位 | `shot_id patch` |
| `reorder_shots` | 调整顺序 | `storyboard_id ordered_shot_ids` |
| `delete_shot` | 软删除/归档 | `shot_id` |
| `reset_shot` | 清空 active 资产、回到 draft；资产保留 | `shot_id` |
| `reset_storyboard` | 写 revision、清空所有 active、status=draft | `storyboard_id` |
| `restore_storyboard` | 回到某个 revision | `storyboard_id revision_id` |
| `set_shot_asset` | 指定某版资产为 active（版本回退） | `shot_id asset_id` |

生成工具扩展：

- `generate_image` / `generate_video` 增加 `shotId`、`sourceAssetIds`（与 `inputImages` 二选一，优先稳定 id）；工具结果写回 `project_assets` 并自动把新资产设为该 shot 的 active。
- `generate_storyboard` 不是一次同步调用：应提交后台作业，按镜头逐个生成，进度可查询、可取消；属于 Phase 2 作业层。

破坏性操作规则：

- `reset_storyboard` / `delete_shot` 必须先明确告知影响范围（几个镜头、哪些资产会被保留），用户确认后才执行；
- 所有删除是软删除或归档，资产表不做物理删除；
- 任何“重新制作”默认生成新资产版本，不覆盖旧版本。

## 6. 典型流程

**建分镜**：用户给 brief → 只问缺少的关键项（平台/画幅、时长、风格）→ `create_storyboard` 写镜头文字草稿 → 复述镜头列表，等确认 → 再逐个 `generate_image`/`generate_video`。

**改第 3 个镜头**：`get_storyboard` → 定位 `shot_id` → `update_shot` 改 prompt/描述 → `generate_image({shotId})` → 新资产成为 active，旧版仍可用 `set_shot_asset` 切回。

**重置分镜**：`reset_storyboard` 前复述“会清空 6 个镜头的当前版本，历史资产保留”；确认后写 revision、清 active；用户想恢复时 `restore_storyboard` 或 `set_shot_asset`。

**重新制作某镜头**：`list_assets({shot_id})` 展示 v1/v2/v3 → 用户说“用 v2 的风格重做” → `get_asset(v2)` 取 prompt/参考 → 生成 v4，不覆盖 v2。

## 7. 实施顺序

1. **Phase 1c 资产账本（先做）**：migration 0003、`title` 进入 artifact、`project_assets` 写入、`<project_assets>` 注入、`list_assets/get_asset`、画布 `customData.assetId`。这一步就能解决“上一轮生成的图和简介下一轮找不到”。
2. **Phase 1d 执行记忆**：PostgresSaver + `thread_id`、上下文预算与工具消息裁剪。对齐 Lavart 并超过它。
3. **Phase 2.5 分镜**：migration 0004（storyboards/shots/revisions）、分镜工具、`<project_state>` 注入；生成作业化之后再接批量分镜生成。
4. **Phase 3 工具深度**：画布 add_text/shape/line/update_style，和分镜镜头联动。

## 8. 验收场景

新增 golden（见 `golden-scenarios.md` G16–G23）：

- 跨轮引用上一轮生成的图片标题/prompt，不重新问用户；
- 修改第 3 个镜头的文字后只重做该镜头；
- 重置分镜后旧资产仍可恢复；
- 指定 v1 资产回退，当前 active 正确切换；
- 两个分镜并存，按标题/ID 找对；
- 资产很多时上下文只带摘要，详情通过 `get_asset` 查；
- 无分镜/无资产时不注入空标签，不说废话；
- 生成失败保留草稿和旧 active，不把镜头状态弄丢。

## 9. 待确认

- 分镜是否允许“一个镜头多个视频版本 + 一个当前封面图”并存？（建议：`assets.kind` 区分，shot 分别有 `active_asset_id` 与 `poster_asset_id`。）
- 分镜批量生成用同步多工具调用还是后台作业？（建议：Phase 2 作业层，先支持逐镜头。）
- 画布元素删除时，资产是否保留？（建议：保留，资产账本与画布解耦。）