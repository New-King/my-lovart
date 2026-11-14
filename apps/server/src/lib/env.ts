const required = (name: string, fallback = "") => process.env[name] ?? fallback;

export const env = {
  port: Number(required("PORT", "3001")),
  webOrigins: required("WEB_ORIGIN", "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceKey: required("SUPABASE_SERVICE_ROLE_KEY"),

  // memory: 进程内存，重启即清空；supabase: 连真实数据库
  projectsStore: (required("PROJECTS_STORE", "supabase") === "supabase" ? "supabase" : "memory") as
    | "supabase"
    | "memory",

  // mock: 返回固定的图片/视频/灵感示例；llm: 走真实模型
  agentMode: (required("AGENT_MODE", "mock") === "llm" ? "llm" : "mock") as "llm" | "mock",

  // mock: 生成链继续走假数据；real: 调 Volces / Metaso 真实生成
  generationMode: (required("GENERATION_MODE", "mock") === "real" ? "real" : "mock") as
    | "real"
    | "mock",

  volcesApiKey: required("VOLCES_API_KEY"),
  volcesApiBase: required("VOLCES_API_BASE", "https://ark.cn-beijing.volces.com/api/v3"),
  volcesImageModel: required("VOLCES_IMAGE_MODEL", "doubao-seedream-5-0-260128"),

  metasoApiKey: required("METASO_API_KEY"),
  metasoApiBase: required("METASO_API_BASE", "https://metaso.cn/api/minimax/"),
  metasoVideoModel: required("METASO_VIDEO_MODEL", "MiniMax-H3"),
};