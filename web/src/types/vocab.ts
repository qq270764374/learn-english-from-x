export type FilterTier =
  | 'strict_1200'
  | 'basic_2000'
  | 'cet4_3500'
  | 'cet6_5500'
  | 'ielts_8000'
  | 'advanced_12000'
  | 'custom'

export interface FilterTierOption {
  value: FilterTier
  label: string
  settingLabel: string
  description: string
}

export const FILTER_TIER_OPTIONS: ReadonlyArray<FilterTierOption> = [
  {
    value: 'strict_1200',
    label: '核心 1200 词（最严格保留初中级词）',
    settingLabel: '核心 1200 词（零基础 / 初中级）',
    description: '仅跳过最基础的 1200 词，优先提取 Zipf 3.8–5.3 日常高频实用词，AI 用初学者视角通俗讲解。',
  },
  {
    value: 'basic_2000',
    label: '基础 2000 词（推荐四级以下起步）',
    settingLabel: '基础 2000 词（推荐四级以下）',
    description: '跳过前 2000 基础词，聚焦 Zipf 3.6–5.1 四级核心高频词与实用短语，兼顾易上手与阅读覆盖率。',
  },
  {
    value: 'cet4_3500',
    label: '四级 3500 词（CET-4 进阶筛选）',
    settingLabel: '四级 3500 词（CET-4 进阶）',
    description: '跳过前 3500 词，聚焦 Zipf 3.3–4.8 四级高阶与向六级过渡词，AI 侧重语境延伸义与常用搭配。',
  },
  {
    value: 'cet6_5500',
    label: '六级 5500 词（CET-6 / B2 流畅阅读）',
    settingLabel: '六级 5500 词（CET-6 / B2）',
    description: '基于 wordfreq 跳过前 5500 高频词，重点保留 Zipf 2.9–4.5 的六级与 B2–C1 精读词汇及熟词僻义。',
  },
  {
    value: 'ielts_8000',
    label: '考研 / 雅思托福 8000 词（B2–C1 精准表达）',
    settingLabel: '考研 / 雅思托福 8000 词',
    description: '跳过前 8000 词，优先抽取 Zipf 2.5–4.1 学术与科技评论常见 C1 词，AI 侧重熟词僻义与语域差异。',
  },
  {
    value: 'advanced_12000',
    label: '高阶原生 12000 词（C1–C2 罕见词与地道用法）',
    settingLabel: '高阶原生 12000 词（C1–C2）',
    description: '跳过前 12000 词，专注 Zipf 2.0–3.7 的 C1–C2 书面/隐喻/专业词及母语者地道习语。',
  },
  {
    value: 'custom',
    label: '自定义词频阈值（自由调节过滤词数与难度区间）',
    settingLabel: '自定义词频阈值',
    description: '自由设定过滤高频词数上限（0–25000）与 Zipf 难度范围（越小越偏生僻高阶），AI 自动匹配对应深度。',
  },
]

export function getFilterTierOption(tier: FilterTier): FilterTierOption {
  return FILTER_TIER_OPTIONS.find((opt) => opt.value === tier) ?? FILTER_TIER_OPTIONS[1]
}

export function normalizeCustomFilterParams(params: {
  customVocabLimit?: number
  customZipfMin?: number
  customZipfMax?: number
}): {
  customVocabLimit: number
  customZipfMin: number
  customZipfMax: number
} {
  const rawLimit = Number(params.customVocabLimit)
  const customVocabLimit = Number.isFinite(rawLimit)
    ? Math.round(Math.min(Math.max(rawLimit, 0), 25000))
    : 5500
  const rawMin = Number(params.customZipfMin)
  const customZipfMin = Number.isFinite(rawMin)
    ? Number(Math.min(Math.max(rawMin, 1.0), 5.8).toFixed(1))
    : 1.8
  const rawMax = Number(params.customZipfMax)
  const minAllowedMax = Number(Math.min(6.5, customZipfMin + 0.3).toFixed(1))
  const customZipfMax = Number.isFinite(rawMax)
    ? Number(Math.min(Math.max(rawMax, minAllowedMax), 6.5).toFixed(1))
    : Math.max(5.0, minAllowedMax)
  return { customVocabLimit, customZipfMin, customZipfMax }
}
export type LLMProvider = 'openai_compatible' | 'gemini'
export type WordCategory = 'standard' | 'collocation' | 'slang'
export type RatingGrade = 1 | 2 | 3 | 4

export interface TweetItem {
  id: string
  url: string
  author_handle: string
  author_name: string
  text: string
  created_at: string
  source_page: string
  captured_at?: string
}

export interface SampleContext {
  tweet_id: string
  author_handle: string
  url: string
  text: string
}

export interface CandidateWord {
  lemma: string
  surface_forms: string[]
  pos: string
  is_phrase: boolean
  is_slang_seed: boolean
  slang_hint: string
  corpus_count: number
  zipf_score: number
  sweet_spot_score: number
  sample_tweets: SampleContext[]
}

export interface FSRSStateModel {
  due: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number // 0=New, 1=Learning, 2=Review, 3=Relearning
  last_review: string | null
}

export interface VocabCard {
  id: string
  word: string
  ipa: string
  pos: string
  category: WordCategory
  cefr_level: string
  meaning_zh: string
  memory_tip_zh: string
  sample_tweet: string
  sample_tweet_zh: string
  author_handle: string
  tweet_url: string
  fsrs: FSRSStateModel
  created_at: string
  updated_at: string
}

export interface ReviewLogEntry {
  card_id: string
  word: string
  rating: RatingGrade | number
  reviewed_at: string
  state: number
}

export interface SyncStateDocument {
  version: number
  updated_at: string
  cards: VocabCard[]
  known_words: string[]
  ignored_words: string[]
  processed_tweet_ids: string[]
  review_logs: ReviewLogEntry[]
}

export interface StarterCreator {
  handle: string
  name: string
  category: string
  url: string
  difficulty: string
  description: string
}

export interface ExtractResponse {
  total_tweets_analyzed: number
  candidates: CandidateWord[]
}

export interface EnrichResponse {
  cards: VocabCard[]
  skipped_ignored: string[]
}

export interface LLMTestResponse {
  ok: boolean
  provider: LLMProvider
  model: string
  endpoint: string
  latency_ms: number
  is_local: boolean
  message: string
  reply_preview: string
  available_models: string[]
}

export type ObsidianSyncMode = 'local_path' | 'rest_api'

export type ObsidianSrCardStyle = 'multiline' | 'bidirectional' | 'inline'

export interface ObsidianRestTestResponse {
  ok: boolean
  url: string
  status_code?: number | null
  authenticated: boolean
  latency_ms: number
  plugin_version: string
  obsidian_version: string
  message: string
  via?: 'browser' | 'backend'
}

export interface ObsidianSrPullResult {
  scanned_notes: number
  notes_with_sr: number
  updated_count: number
  updated_words: string[]
  updated_cards: VocabCard[]
  via?: 'browser' | 'backend'
}

export interface ObsidianSrLaunchResult {
  ok: boolean
  command_id: string
  command_name: string
  message: string
  via?: 'browser' | 'backend'
}

export interface UserSettings {
  llmProvider: LLMProvider
  llmApiKey: string
  llmBaseUrl: string
  llmModel: string
  geminiApiKey: string
  geminiModel: string
  googleClientId: string
  driveFileId: string
  lastSyncedAt: string
  filterTier: FilterTier
  customVocabLimit: number
  customZipfMin: number
  customZipfMax: number
  dailyNewLimit: number
  ttsAccent: 'en-US' | 'en-GB'
  showContextOnFront: boolean
  obsidianSyncMode: ObsidianSyncMode
  obsidianVaultPath: string
  obsidianRestUrl: string
  obsidianRestApiKey: string
  obsidianSubfolder: string
  obsidianIncludeFlashcards: boolean
  obsidianSrDeckTag: string
  obsidianSrCardStyle: ObsidianSrCardStyle
  obsidianSrSubdeckByCategory: boolean
  obsidianSrSyncProgress: boolean
  obsidianSrAudio: boolean
  obsidianSrAudioAutoplay: boolean
  obsidianAutoSync: boolean
}

export const DEFAULT_SETTINGS: UserSettings = {
  llmProvider: 'openai_compatible',
  llmApiKey: '',
  llmBaseUrl: 'https://api.deepseek.com/v1',
  llmModel: 'deepseek-chat',
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  googleClientId: '',
  driveFileId: '',
  lastSyncedAt: '',
  filterTier: 'basic_2000',
  customVocabLimit: 5500,
  customZipfMin: 1.8,
  customZipfMax: 5.0,
  dailyNewLimit: 15,
  ttsAccent: 'en-US',
  showContextOnFront: true,
  obsidianSyncMode: 'local_path',
  obsidianVaultPath: '',
  obsidianRestUrl: 'https://127.0.0.1:27124',
  obsidianRestApiKey: '',
  obsidianSubfolder: 'X-Vocab',
  obsidianIncludeFlashcards: true,
  obsidianSrDeckTag: '#flashcards/x-vocab',
  obsidianSrCardStyle: 'multiline',
  obsidianSrSubdeckByCategory: false,
  obsidianSrSyncProgress: true,
  obsidianSrAudio: true,
  obsidianSrAudioAutoplay: true,
  obsidianAutoSync: false,
}

export function createEmptySyncState(): SyncStateDocument {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    cards: [],
    known_words: [],
    ignored_words: [],
    processed_tweet_ids: [],
    review_logs: [],
  }
}
