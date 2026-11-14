const required = (name: string, fallback = "") => process.env[name] ?? fallback;

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

  volcesApiKey: required("VOLCES_API_KEY"),
  volcesApiBase: required("VOLCES_API_BASE", "https://ark.cn-beijing.volces.com/api/v3"),
  volcesImageModel: required("VOLCES_IMAGE_MODEL", "doubao-seedream-5-0-260128"),

  metasoApiKey: required("METASO_API_KEY"),
  metasoApiBase: required("METASO_API_BASE", "https://metaso.cn/api/minimax/"),
  metasoVideoModel: required("METASO_VIDEO_MODEL", "MiniMax-H3"),

  /** Agent 走 OpenAI 兼容接口；项目里默认是 DeepSeek */
  openAiApiKey: required("OPENAI_API_KEY"),
  openAiApiBase: required("OPENAI_API_BASE", "https://api.openai.com/v1"),
  agentModel: required("LOOMIC_AGENT_MODEL", required("OPENAI_MODEL", "deepseek-chat")),
};