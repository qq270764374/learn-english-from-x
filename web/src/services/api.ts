import { buildOfflineDemoCards, OFFLINE_DEMO_TWEETS, STARTER_CREATORS } from '../data/starterCreators'
import type {
  CandidateWord,
  EnrichResponse,
  ExtractResponse,
  FilterTier,
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
  default_provider?: string
  default_model?: string
}> {
  try {
    const resp = await fetch('/api/health')
    if (!resp.ok) return { online: false }
    const data = (await resp.json()) as { default_provider?: string; default_model?: string }
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
      known_words: params.known_words,
      ignored_words: params.ignored_words,
      max_candidates: params.max_candidates ?? 80,
      include_slang: params.include_slang ?? true,
    }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return (await resp.json()) as ExtractResponse
}

export async function enrichCandidates(params: {
  candidates: CandidateWord[]
  settings: UserSettings
  autoSave?: boolean
}): Promise<EnrichResponse> {
  const { settings } = params
  const isGemini = settings.llmProvider === 'gemini'

  const llmConfig = {
    provider: settings.llmProvider,
    api_key: (isGemini ? settings.geminiApiKey : settings.llmApiKey).trim() || null,
    base_url: isGemini ? null : settings.llmBaseUrl.trim() || null,
    model: (isGemini ? settings.geminiModel : settings.llmModel).trim() || null,
  }

  const resp = await fetch('/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidates: params.candidates,
      llm_config: llmConfig,
      auto_save: params.autoSave ?? true,
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
}): Promise<Blob> {
  const resp = await fetch('/api/export/obsidian-zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cards: params.cards,
      subfolder: params.subfolder || 'X-Vocab',
      include_flashcards: params.includeFlashcards,
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
}): Promise<ObsidianSyncResult> {
  const resp = await fetch('/api/export/obsidian-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cards: params.cards,
      vault_path: params.vaultPath,
      subfolder: params.subfolder || 'X-Vocab',
      include_flashcards: params.includeFlashcards,
    }),
  })
  if (!resp.ok) throw new Error(await parseErrorMessage(resp))
  return (await resp.json()) as ObsidianSyncResult
}

