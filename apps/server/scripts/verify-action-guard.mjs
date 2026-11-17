/**
 * 动作镜头主体契约：不调模型、不写数据库。
 * 验证“压弯/骑行/驶入”这类动作必须有骑手/人物，纯产品运镜不误伤。
 *
 * 用法：pnpm --filter @my-lovart/server verify:action-guard
 */
const {
  actionActorError,
  promptMentionsActor,
  promptRequiresHumanAction,
} = await import("../dist/features/agent/tools.js");

const cases = [
  {
    name: "单车压弯但没写骑手：拒绝",
    text: "竖构图 9:16。公路竞速车从画面前方远处高速压弯逼近镜头，车身向弯内侧倾斜，深框轮组高速旋转，无文字无 logo。",
    expectError: "action_actor_required",
  },
  {
    name: "写了骑手压低身体压弯：放行",
    text: "竖构图 9:16。骑手压低身体，公路竞速车在盘山弯道压弯逼近镜头，车手视线看向弯心，无文字无 logo。",
    expectError: null,
  },
  {
    name: "纯产品运镜（环绕/轮组转动）：不误判",
    text: "镜头环绕公路车缓慢推近，轮组高速旋转，侧光扫过车架，产品棚拍质感。",
    expectError: null,
  },
  {
    name: "否定句“不要骑手压弯”：不误判",
    text: "不要骑手压弯，改成镜头环绕公路车，展示车架与轮组细节。",
    expectError: null,
  },
  {
    name: "车辆位移但没写骑手：拒绝",
    text: "公路车从画面右侧高速驶入，车轮压过柏油路面。",
    expectError: "action_actor_required",
  },
  {
    name: "人物起身：有主体放行 / 无主体拒绝",
    textWithActor: "人物从椅子上站起来，走向镜头。",
    textWithoutActor: "从椅子上站起来，走向镜头。",
    expectError: "action_actor_required",
  },
];

let failed = 0;
for (const item of cases) {
  if (item.textWithActor || item.textWithoutActor) {
    const withActor = actionActorError(item.textWithActor);
    const withoutActor = actionActorError(item.textWithoutActor);
    const pass = !withActor && withoutActor?.code === item.expectError;
    console.log(
      `${pass ? "✓" : "✗"} ${item.name} · 有主体=${
        withActor?.code ?? "allowed"
      } / 无主体=${withoutActor?.code ?? "allowed"}`,
    );
    if (!pass) failed += 1;
    continue;
  }

  const result = actionActorError(item.text);
  const pass = (result?.code ?? null) === item.expectError;
  console.log(
    `${pass ? "✓" : "✗"} ${item.name} · ${
      result?.code ?? "allowed"
    } (requires=${promptRequiresHumanAction(item.text)}, actor=${promptMentionsActor(
      item.text,
    )})`,
  );
  if (!pass) failed += 1;
}

console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed === 0 ? 0 : 1);