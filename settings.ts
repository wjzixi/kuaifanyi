// ============ API 提供商标识 ============
export type ApiProvider = "deepseek" | "qwen" | "doubao" | "kimi" | "zhipu" | "custom";

export interface ProviderConfig { name: string; apiUrl: string; model: string; }

export const API_PRESETS: Record<ApiProvider, ProviderConfig> = {
  deepseek: { name: "DeepSeek", apiUrl: "https://api.deepseek.com/chat/completions", model: "deepseek-chat" },
  qwen:     { name: "千问 (阿里云)", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus" },
  doubao:   { name: "豆包 (火山方舟)", apiUrl: "https://ark.cn-beijing.volces.com/api/v3/chat/completions", model: "doubao-pro-256k" },
  kimi:     { name: "Kimi (月之暗面)", apiUrl: "https://api.moonshot.cn/v1/chat/completions", model: "moonshot-v1-8k" },
  zhipu:    { name: "智谱 GLM", apiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4" },
  custom:   { name: "自定义（OpenAI 兼容）", apiUrl: "https://api.deepseek.com/chat/completions", model: "deepseek-chat" },
};

// ============ TTS 引擎 ============
export type TtsEngine = "volcano" | "system";

// ============ 插件设置 ============
export interface KuaifanyiSettings {
  apiProvider: ApiProvider;
  apiKey: string;
  providerKeys: Record<string, string>; // 各提供商的 API Key 缓存
  customApiUrl: string;
  customModel: string;
  translateModel: string;
  chunkSize: number;
  triggerMode: "direct" | "ctrl";
  autoTranslate: boolean;
  autoExplain: boolean;
  autoRead: boolean;
  triggerDebounce: number;
  explainModel: string;
  // TTS
  ttsEngine: TtsEngine;
  ttsVoice: string;
  ttsRate: number;
  ttsPitch: number;
  // 火山豆包语音
  volcanoAppId: string;
  volcanoToken: string;
  volcanoVoice: string;
  // 火山计费（查余额，可选）
  volcanoAccessKeyId: string;
  volcanoSecretAccessKey: string;
  // 阿里云计费（查余额，可选）
  aliyunAccessKeyId: string;
  aliyunSecretAccessKey: string;
  // 语音缓存
  ttsCacheEnabled: boolean;
  ttsCacheDir: string;
  // 本月用量（自动维护，无需手填）
  volcanoMonth: string;
  volcanoMonthChars: number;
  volcanoMonthCalls: number;
}

export const DEFAULT_SETTINGS: KuaifanyiSettings = {
  apiProvider: "deepseek",
  apiKey: "",
  providerKeys: {},
  customApiUrl: "https://api.deepseek.com/chat/completions",
  customModel: "deepseek-chat",
  translateModel: "deepseek-chat",
  chunkSize: 2000,
  triggerMode: "direct",
  autoTranslate: true,
  autoExplain: false,
  autoRead: false,
  triggerDebounce: 500,
  explainModel: "deepseek-v4-flash",
  ttsEngine: "volcano",
  ttsVoice: "",
  ttsRate: 1.0,
  ttsPitch: 1.0,
  volcanoAppId: "",
  volcanoToken: "",
  volcanoVoice: "zh_female_vv_uranus_bigtts",
  volcanoAccessKeyId: "",
  volcanoSecretAccessKey: "",
  aliyunAccessKeyId: "",
  aliyunSecretAccessKey: "",
  ttsCacheEnabled: true,
  ttsCacheDir: "",
  volcanoMonth: "",
  volcanoMonthChars: 0,
  volcanoMonthCalls: 0,
};
