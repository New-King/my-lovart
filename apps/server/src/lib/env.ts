const required = (name: string, fallback = "") => process.env[name] ?? fallback;

/** 多代环境变量名共存：新名字优先，旧名字继续可用，避免部署时一起改。 */
const first = (...values: string[]) => values.find((value) => value.trim().length > 0) ?? "";

const quality = (value: string): "standard" | "hd" | "ultra" =>
  value === "standard" || value === "ultra" ? value : "hd";

const resolution = (value: string): "480p" | "720p" | "1080p" =>
  value === "480p" || value === "1080p" ? value : "720p";

export const env = {
  port: Number(required("PORT", "3001")),
  webOrigins: required("WEB_ORIGIN", "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  /** Postgres 直连/pooler 地址，checkpointer 用；没有就退化为无执行记忆 */
  supabaseDbUrl: required("SUPABASE_DB_URL"),

  // memory: 进程内存，重启即清空；supabase: 连真实数据库
  projectsStore: (required("PROJECTS_STORE", "supabase") === "supabase" ? "supabase" : "memory") as
    | "supabase"
    | "memory",

  // mock: 生成链继续走假数据；real: LangGraph Agent + Volces / Metaso 真实生成
  generationMode: (required("GENERATION_MODE", "mock") === "real" ? "real" : "mock") as
    | "real"
    | "mock",

  // 生成渠道：注册表按 key 自动注册；IMAGE_PROVIDER/VIDEO_PROVIDER 可选，用于同一模型多渠道路由
  imageProvider: required("IMAGE_PROVIDER"),
  imageModel: first(
    required("IMAGE_MODEL"),
    required("VOLCES_IMAGE_MODEL"),
    "doubao-seedream-4-5-251128",
  ),
  imageQuality: quality(required("IMAGE_QUALITY", "hd")),
  imageWatermark: first(required("ARK_IMAGE_WATERMARK"), "false") === "true",
  /** Ark 新名字；VOLCES_API_KEY 是历史名字，两者都支持 */
  arkApiKey: first(required("ARK_API_KEY"), required("VOLCES_API_KEY")),
  arkApiBase: first(
    required("ARK_API_BASE"),
    required("VOLCES_API_BASE"),
    "https://ark.cn-beijing.volces.com/api/v3",
  ),
  /** 兼容旧读取点，后续代码统一用 arkApiKey / arkApiBase */
  volcesApiKey: first(required("ARK_API_KEY"), required("VOLCES_API_KEY")),
  volcesApiBase: first(
    required("ARK_API_BASE"),
    required("VOLCES_API_BASE"),
    "https://ark.cn-beijing.volces.com/api/v3",
  ),
  volcesImageModel: first(
    required("IMAGE_MODEL"),
    required("VOLCES_IMAGE_MODEL"),
    "doubao-seedream-4-5-251128",
  ),

  videoProvider: required("VIDEO_PROVIDER"),
  videoModel: first(required("VIDEO_MODEL"), required("METASO_VIDEO_MODEL"), "MiniMax-H3"),
  videoResolution: resolution(required("VIDEO_RESOLUTION", "720p")),
  metasoApiKey: required("METASO_API_KEY"),
  metasoApiBase: required("METASO_API_BASE", "https://metaso.cn/api/minimax/"),
  metasoVideoModel: first(required("VIDEO_MODEL"), required("METASO_VIDEO_MODEL"), "MiniMax-H3"),

  /** Agent 走 OpenAI 兼容接口；项目里默认是 DeepSeek */
  openAiApiKey: required("OPENAI_API_KEY"),
  openAiApiBase: required("OPENAI_API_BASE", "https://api.openai.com/v1"),
  agentModel: required("LOOMIC_AGENT_MODEL", required("OPENAI_MODEL", "deepseek-chat")),
};