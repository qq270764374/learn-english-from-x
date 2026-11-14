export type FilterTier = 'strict_1200' | 'basic_2000' | 'cet4_3500'
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
  dailyNewLimit: number
  ttsAccent: 'en-US' | 'en-GB'
  showContextOnFront: boolean
  obsidianVaultPath: string
  obsidianSubfolder: string
  obsidianIncludeFlashcards: boolean
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
  dailyNewLimit: 15,
  ttsAccent: 'en-US',
  showContextOnFront: true,
  obsidianVaultPath: '',
  obsidianSubfolder: 'X-Vocab',
  obsidianIncludeFlashcards: true,
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
