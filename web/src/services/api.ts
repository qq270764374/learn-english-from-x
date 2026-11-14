import { buildOfflineDemoCards, OFFLINE_DEMO_TWEETS, STARTER_CREATORS } from '../data/starterCreators'
import type {
  CandidateWord,
  EnrichResponse,
  ExtractResponse,
  FilterTier,
  LLMProvider,
  LLMTestResponse,
  ObsidianSrCardStyle,
  ObsidianSrLaunchResult,
  ObsidianSrPullResult,
  StarterCreator,
  SyncStateDocument,
  TweetItem,
  UserSettings,
  VocabCard,
} from '../types/vocab'

async function parseErrorMessage(resp: Response): Promise<string> {
  try {
    const data = (await resp.json()) as { detail?: string }
    if (data?.detail) return data.detail
  } catch {
    // Ignore non-JSON error bodies
  }
  return `请求失败 (HTTP ${resp.status})`
}

export async function checkBackendHealth(): Promise<{
  online: boolean
  default_provider?: LLMProvider
  default_base_url?: string
  default_model?: string
  default_filter_tier?: FilterTier
}> {
  try {
    const resp = await fetch('/api/health')
    if (!resp.ok) return { online: false }
    const data = (await resp.json()) as {
      default_provider?: LLMProvider
      default_base_url?: string
      default_model?: string
      default_filter_tier?: FilterTier
    }
    return { online: true, ...data }
  } catch {
    return { online: false }
  }
}

export async function fetchStarterCreators(): Promise<StarterCreator[]> {
  try {
    const resp = await fetch('/api/creators')
    if (!resp.ok) throw new Error()
    return (await resp.json()) as StarterCreator[]
  } catch {
    return STARTER_CREATORS
  }
}

export async function fetchDemoTweets(): Promise<TweetItem[]> {
  try {
    const resp = await fetch('/api/demo-tweets')
    if (!resp.ok) throw new Error()
    return (await resp.json()) as TweetItem[]
  } catch {
    return OFFLINE_DEMO_TWEETS
  }
}

export async function fetchDemoCards(): Promise<VocabCard[]> {
  try {
    const resp = await fetch('/api/demo-cards')
    if (!resp.ok) throw new Error()
    return (await resp.json()) as VocabCard[]
  } catch {
    return buildOfflineDemoCards()
  }
}

export async function fetchBackendTweets(): Promise<TweetItem[]> {
  const resp = await fetch('/api/tweets')
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return (await resp.json()) as TweetItem[]
}

export async function ingestTweetsToBackend(tweets: TweetItem[]): Promise<{ added: number; total_tweets: number }> {
  const resp = await fetch('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tweets }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return (await resp.json()) as { added: number; total_tweets: number }
}

export async function extractCandidates(params: {
  tweets?: TweetItem[]
  filter_tier: FilterTier
  custom_vocab_limit?: number
  custom_zipf_min?: number
  custom_zipf_max?: number
  known_words: string[]
  ignored_words: string[]
  max_candidates?: number
  include_slang?: boolean
}): Promise<ExtractResponse> {
  const resp = await fetch('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tweets: params.tweets,
      filter_tier: params.filter_tier,
      ...(params.custom_vocab_limit !== undefined ? { custom_vocab_limit: params.custom_vocab_limit } : {}),
      ...(params.custom_zipf_min !== undefined ? { custom_zipf_min: params.custom_zipf_min } : {}),
      ...(params.custom_zipf_max !== undefined ? { custom_zipf_max: params.custom_zipf_max } : {}),
      known_words: params.known_words,
      ignored_words: params.ignored_words,
      max_candidates: params.max_candidates ?? 80,
      include_slang: params.include_slang ?? true,
    }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return (await resp.json()) as ExtractResponse
}

function buildLlmOverrideConfig(settings: UserSettings) {
  const isGemini = settings.llmProvider === 'gemini'
  return {
    provider: settings.llmProvider,
    api_key: (isGemini ? settings.geminiApiKey : settings.llmApiKey).trim() || null,
    base_url: isGemini ? null : settings.llmBaseUrl.trim() || null,
    model: (isGemini ? settings.geminiModel : settings.llmModel).trim() || null,
  }
}

export async function testLlmConnection(settings: UserSettings): Promise<LLMTestResponse> {
  let resp: Response
  try {
    resp = await fetch('/api/llm/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm_config: buildLlmOverrideConfig(settings) }),
    })
  } catch {
    throw new Error('无法连接本地 Python 后端（http://127.0.0.1:8765），请先运行 start.sh 启动服务后再测试连通性。')
  }

  if (!resp.ok) {
    if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
      throw new Error('无法连接本地 Python 后端（http://127.0.0.1:8765），请确认已运行 start.sh。')
    }
    throw new Error(await parseErrorMessage(resp))
  }
  return (await resp.json()) as LLMTestResponse
}

export async function enrichCandidates(params: {
  candidates: CandidateWord[]
  settings: UserSettings
  autoSave?: boolean
  filterTier?: FilterTier
  customVocabLimit?: number
}): Promise<EnrichResponse> {
  const resp = await fetch('/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidates: params.candidates,
      llm_config: buildLlmOverrideConfig(params.settings),
      auto_save: params.autoSave ?? true,
      filter_tier: params.filterTier ?? params.settings.filterTier,
      custom_vocab_limit: params.customVocabLimit ?? params.settings.customVocabLimit,
    }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return (await resp.json()) as EnrichResponse
}

export async function syncWithBackendStore(localState: SyncStateDocument): Promise<SyncStateDocument | null> {
  try {
    const resp = await fetch('/api/state/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(localState),
    })
    if (!resp.ok) return null
    return (await resp.json()) as SyncStateDocument
  } catch {
    return null
  }
}

export async function exportApkgFile(cards: VocabCard[], deckName = 'LearnEnglishFromX'): Promise<Blob> {
  const resp = await fetch('/api/export/apkg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cards, deck_name: deckName }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return await resp.blob()
}

export async function exportObsidianZip(params: {
  cards: VocabCard[]
  subfolder: string
  includeFlashcards: boolean
  srDeckTag?: string
  srCardStyle?: ObsidianSrCardStyle
  srSubdeckByCategory?: boolean
  srSeedProgress?: boolean
  srIncludeAudio?: boolean
  srAudioAutoplay?: boolean
  ttsAccent?: 'en-US' | 'en-GB'
}): Promise<Blob> {
  const resp = await fetch('/api/export/obsidian-zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cards: params.cards,
      subfolder: params.subfolder || 'X-Vocab',
      include_flashcards: params.includeFlashcards,
      sr_deck_tag: params.srDeckTag || '#flashcards/x-vocab',
      sr_card_style: params.srCardStyle || 'multiline',
      sr_subdeck_by_category: params.srSubdeckByCategory ?? false,
      sr_seed_progress: params.srSeedProgress ?? false,
      sr_include_audio: params.srIncludeAudio ?? false,
      sr_audio_autoplay: params.srAudioAutoplay ?? false,
      tts_accent: params.ttsAccent || 'en-US',
    }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return await resp.blob()
}

export interface ObsidianSyncResult {
  target_dir: string
  written_count: number
  files: string[]
}

export async function syncObsidianVault(params: {
  cards: VocabCard[]
  vaultPath: string
  subfolder: string
  includeFlashcards: boolean
  srDeckTag?: string
  srCardStyle?: ObsidianSrCardStyle
  srSubdeckByCategory?: boolean
  srSeedProgress?: boolean
  srIncludeAudio?: boolean
  srAudioAutoplay?: boolean
  ttsAccent?: 'en-US' | 'en-GB'
}): Promise<ObsidianSyncResult> {
  const resp = await fetch('/api/export/obsidian-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cards: params.cards,
      vault_path: params.vaultPath,
      subfolder: params.subfolder || 'X-Vocab',
      include_flashcards: params.includeFlashcards,
      sr_deck_tag: params.srDeckTag || '#flashcards/x-vocab',
      sr_card_style: params.srCardStyle || 'multiline',
      sr_subdeck_by_category: params.srSubdeckByCategory ?? false,
      sr_seed_progress: params.srSeedProgress ?? false,
      sr_include_audio: params.srIncludeAudio ?? false,
      sr_audio_autoplay: params.srAudioAutoplay ?? false,
      tts_accent: params.ttsAccent || 'en-US',
    }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return (await resp.json()) as ObsidianSyncResult
}

export interface ObsidianRestBackendTestResult {
  ok: boolean
  url: string
  status_code?: number | null
  authenticated: boolean
  latency_ms: number
  plugin_version: string
  obsidian_version: string
  message: string
}

export async function testObsidianRestViaBackend(params: {
  apiUrl: string
  apiKey: string
}): Promise<ObsidianRestBackendTestResult> {
  const resp = await fetch('/api/export/obsidian-rest-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_url: params.apiUrl.trim(),
      api_key: params.apiKey.trim(),
    }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return (await resp.json()) as ObsidianRestBackendTestResult
}

export async function syncObsidianRestViaBackend(params: {
  cards: VocabCard[]
  apiUrl: string
  apiKey: string
  subfolder: string
  includeFlashcards: boolean
  srDeckTag?: string
  srCardStyle?: ObsidianSrCardStyle
  srSubdeckByCategory?: boolean
  srSeedProgress?: boolean
  srIncludeAudio?: boolean
  srAudioAutoplay?: boolean
  ttsAccent?: 'en-US' | 'en-GB'
}): Promise<ObsidianSyncResult> {
  const resp = await fetch('/api/export/obsidian-rest-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cards: params.cards,
      api_url: params.apiUrl.trim(),
      api_key: params.apiKey.trim(),
      subfolder: params.subfolder || 'X-Vocab',
      include_flashcards: params.includeFlashcards,
      sr_deck_tag: params.srDeckTag || '#flashcards/x-vocab',
      sr_card_style: params.srCardStyle || 'multiline',
      sr_subdeck_by_category: params.srSubdeckByCategory ?? false,
      sr_seed_progress: params.srSeedProgress ?? false,
      sr_include_audio: params.srIncludeAudio ?? false,
      sr_audio_autoplay: params.srAudioAutoplay ?? false,
      tts_accent: params.ttsAccent || 'en-US',
    }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return (await resp.json()) as ObsidianSyncResult
}

export async function pullObsidianSrViaBackend(params: {
  mode: 'local_path' | 'rest_api'
  cards: VocabCard[]
  vaultPath?: string
  apiUrl?: string
  apiKey?: string
  subfolder: string
  applyToStore?: boolean
}): Promise<ObsidianSrPullResult> {
  const resp = await fetch('/api/export/obsidian-sr-pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: params.mode,
      cards: params.cards,
      vault_path: params.vaultPath?.trim() || null,
      api_url: params.apiUrl?.trim() || null,
      api_key: params.apiKey?.trim() || null,
      subfolder: params.subfolder || 'X-Vocab',
      apply_to_store: params.applyToStore ?? true,
    }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return (await resp.json()) as ObsidianSrPullResult
}

export async function launchObsidianSrViaBackend(params: {
  apiUrl: string
  apiKey: string
  commandId?: string
}): Promise<ObsidianSrLaunchResult> {
  const resp = await fetch('/api/export/obsidian-sr-launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_url: params.apiUrl.trim(),
      api_key: params.apiKey.trim(),
      command_id: params.commandId?.trim() || null,
    }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return (await resp.json()) as ObsidianSrLaunchResult
}

