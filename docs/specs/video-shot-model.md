# 结构化镜头契约（草案）

> 状态：草案，未实现；先定契约，再改工具和前端
> 日期：2026-11-17
> 关联：`docs/specs/video-preproduction.md`、`docs/notes/M40.md`

## 为什么需要它

公路车第 1 镜的失败不是“压弯”这个词没写对，而是镜头缺少可执行的结构：

- 谁是主角？（产品车 / 产品车 + 骑手 / 路人）
- 谁执行动作？（骑手 / 产品自身 / 只有镜头在动）
- 首帧是什么状态？（停着 / 已经压弯 / 已经骑到近景）
- 动作从哪个状态变到哪个状态？
- 哪些主体允许动，哪些必须保持静止？

这些信息现在都藏在自由文本 `description` / `prompt` 里，靠模型自己解释；一旦解释错，图片和视频就会各自跑偏。关键词闸门（`action_actor_required`）只能挡住“写了压弯但没写骑手”的显式矛盾，挡不住同义词、隐含动作、背景第二主体、首帧姿态不对等问题。

## 镜头契约

每个 `kind=video` 的镜头，除了标题/时长，还应有结构化 `motion`：

```json
{
  "subject": {
    "hero": { "name": "公路车", "type": "product", "assetId": "canon-id" },
    "actors": [
      { "name": "骑手", "type": "person", "required": true }
    ]
  },
  "action": {
    "type": "human_action",
    "performer": "骑手",
    "description": "压低身体，向弯心压弯，向镜头逼近"
  },
  "camera": {
    "move": "pull_back",
    "description": "超低机位，后拉跟随"
  },
  "startState": {
    "frame": "action_keyframe",
    "actorVisible": true,
    "pose": "骑手已在车上，身体向弯内侧倾斜约 25°",
    "position": "画面中景偏右",
    "motionCues": ["车轮轻微运动模糊", "湿路面水汽"]
  },
  "endState": {
    "pose": "仍保持压弯，车身更靠近镜头",
    "position": "画面近景，占画面约二分之一"
  },
  "allowedMotion": ["骑手", "公路车"],
  "staticConstraints": ["不要出现第二个骑手", "不要出现第二辆车"]
}
```

字段含义：

| 字段 | 作用 | 缺省时 |
| --- | --- | --- |
| `subject.hero` | 唯一主角；产品/角色/车辆 | 必填 |
| `subject.actors` | 执行动作的人/动物；可空 | 动作需要人时必填 |
| `action.type` | `none / camera / product_motion / human_action / environment` | 必填 |
| `action.performer` | 谁做动作；必须是 hero 或 actors 之一 | 动作非 none 时必填 |
| `camera.move` | 镜头运动，和主体运动分开 | 可选 |
| `startState` | 首帧必须成立的状态 | 必填 |
| `endState` | 尾帧/结束状态 | 可选；有则可驱动尾帧 |
| `allowedMotion` | 允许运动的主体白名单 | 默认只有 performer |
| `staticConstraints` | 必须静止/不能出现的对象 | 可选 |

## 校验规则（服务端）

1. `action.type !== "none"` 时必须有 `performer`；`performer` 必须出现在 `subject.hero` 或 `subject.actors`。
2. `action.type === "human_action"` 时，`startState.actorVisible` 必须为 true，且 `startState.pose` 不能为空；首帧不能是 `product_canon` 静物图。
3. `action.type === "product_motion"` 且产品不是自驱对象（单车、普通杯子、家具等）时，必须有 actor，或改成 `camera`。
4. `action.type === "camera"` 时才允许首帧是无人物产品图；视频 prompt 只能写镜头运动，不能写“产品自己骑走”。
5. `startState.frame === "action_keyframe"` 时，关键帧生成的身份锁只锁身份（车型/配色/材质/结构），不锁姿态；必须允许按 `startState` 重新构图并加入 actor。
6. 视频 prompt 由结构化字段拼装，禁止模型另起一段自由文本引入新主体；如果自由文本和 `allowedMotion` 冲突，以结构为准。

## 生成模式决策

| 动作类型 | 首帧 | 视频方式 |
| --- | --- | --- |
| 只有镜头运动 | 产品 canon / 场景图 | image-to-video，prompt 只描述镜头 |
| 产品自身可动（轮组、灯光、机械结构） | 产品图 / 局部特写 | image-to-video，明确可动部件 |
| 人物动作（骑、跑、站起、挥手） | 必须动作关键帧，actor + pose 已存在 | image-to-video；首尾帧条件更好 |
| 人物动作但没有动作首帧 | 不要出片 | 先补动作关键帧；或改用 reference-to-video / text-to-video 并接受身份风险 |
| 多主体/背景有人 | 明确 `staticConstraints` | 首帧只保留一个主角；背景主体不做动作 |

这张表是流程规则，不依赖某个具体项目或某个词。

## Prompt 拼装

视频 prompt 不再让模型自由发挥，而是服务端按结构拼：

```
主体：<hero>；执行动作：<performer> <action.description>。
起始状态：<startState.pose / position / motionCues>。
结束状态：<endState>。
镜头：<camera.description>。
只允许 <allowedMotion> 运动；<staticConstraints> 必须保持静止或不存在。
```

这样“从画面深处驶来”这种空间关系错误会在拼装前被发现：如果 `startState.position` 是近景，结束状态也是近景，就不会生成“从深处”的句子。

## 关键帧身份锁

- 非动作帧：保持现状——锁身份和构图，只改机位/光线/背景。
- 动作帧：只锁身份（车型、比例、材质、配色、结构、标志位置），明确允许重新构图、改变姿态、加入 actor。
- 当前 `actionSubject` 是这条规则的过渡实现；结构化契约落地后，由 `action.type` 决定，不再靠关键词。

## 迁移路径

1. `create_storyboard` / `update_shot` 的 zod schema 增加可选 `motion`；先不强制，避免旧调用失败。
2. Agent 提示词要求：新建 `kind=video` 分镜时填写 `motion`；不填则退回现有自由文本 + 关键词兜底，并在返回里警告。
3. `planImageReferences` / `checkVideoPreflight` 优先读 `motion`；有结构时按结构校验，没有结构时才跑关键词检查。
4. `generate_video` 的 prompt 由服务端按结构拼装；模型传入的自由文本只作为补充，不允许覆盖主体白名单。
5. 前端分镜 UI 显示“主角 / 动作 / 镜头 / 起始状态”，让用户在确认锚图/首帧时能看到声明是否一致。
6. 新视频分镜默认要求 `motion`；旧分镜保持兼容。

## 视觉校验（下一层）

结构只能保证“声明正确”，不能保证生成图真的对。首帧出图后应做一次开始状态检查：

- 是否出现声明的 actor；
- 姿态是否接近 `startState.pose`；
- 是否出现第二个主角/第二辆车；
- 产品身份是否仍是 canon。

当前没有接入视觉模型；短期靠用户确认首帧，长期可加一个 VLM 检查或人工确认 UI。没有这一步，不能说“保证出片正确”。

## 验收场景（通用）

- G51：人物动作镜头缺 actor 的起始状态 → 拒绝关键帧，不能出片。
- G52：产品纯运镜（环绕/推近）无 actor → 允许，且 prompt 不出现主体位移。
- G53：多主体首帧（前景产品 + 背景骑手）→ 结构声明只能有一个主角，视频 prompt 不允许背景主体运动。
- G54：动作关键帧生成 → 身份锁不冻结姿态，生成结果包含 actor 和动作。
- G55：结构化 prompt 拼装 → 视频 prompt 的起始/结束状态与首尾帧一致，不出现“从画面深处”这类空间矛盾。

## 待问 Lovart

1. 分镜/镜头的数据结构里，是否区分 `subject / action / camera / startState / endState`？字段名和枚举是什么？
2. 产品需要被人骑/使用时，首帧用产品图还是动作关键帧？是否用首尾帧条件或 reference-to-video？
3. 如何防止背景人物/第二主体抢运动？是主体白名单、蒙版、多参考图，还是 prompt 约束？
4. 首帧生成后有没有视觉校验（actor 是否存在、姿态、多主体）再出视频，还是只靠用户确认？
5. 视频 prompt 是自由文本还是结构化拼装？如何处理“镜头运动”和“主体运动”的歧义？
6. 当首帧无法承载动作时，降级策略是什么：换首帧、文生视频、改分镜，还是改纯产品运镜？

## 不做

- 不按某个具体项目写关键词补丁；
- 不把“压弯/骑行”这种词表当最终方案；
- 不在没有视觉校验/用户确认的情况下承诺“视频一定按意图动”。