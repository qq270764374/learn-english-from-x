import { createEmptySyncState, DEFAULT_SETTINGS, type SyncStateDocument, type TweetItem, type UserSettings } from '../types/vocab'

const DB_NAME = 'learn_english_from_x_db'
const DB_VERSION = 1
const STORE_NAME = 'kv_store'

const KEYS = {
  SYNC_STATE: 'sync_state_v1',
  SETTINGS: 'user_settings_v1',
  CACHED_TWEETS: 'cached_tweets_v1',
} as const

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet<T>(key: string): Promise<T | null> {
  if (hasIndexedDb()) {
    try {
      const db = await openDb()
      return await new Promise<T | null>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const store = tx.objectStore(STORE_NAME)
        const req = store.get(key)
        req.onsuccess = () => resolve((req.result as T | undefined) ?? null)
        req.onerror = () => reject(req.error)
      })
    } catch {
      // Fallback to localStorage below
    }
  }
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

async function idbSet<T>(key: string, value: T): Promise<void> {
  if (hasIndexedDb()) {
    try {
      const db = await openDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        const req = store.put(value, key)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
      return
    } catch {
      // Fallback to localStorage below
    }
  }
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore quota errors in restricted environments
  }
}

export async function loadLocalSyncState(): Promise<SyncStateDocument> {
  const stored = await idbGet<SyncStateDocument>(KEYS.SYNC_STATE)
  if (!stored || !Array.isArray(stored.cards)) {
    return createEmptySyncState()
  }
  return {
    version: stored.version ?? 1,
    updated_at: stored.updated_at || new Date().toISOString(),
    cards: stored.cards ?? [],
    known_words: stored.known_words ?? [],
    ignored_words: stored.ignored_words ?? [],
    processed_tweet_ids: stored.processed_tweet_ids ?? [],
    review_logs: stored.review_logs ?? [],
  }
}

export async function saveLocalSyncState(state: SyncStateDocument): Promise<void> {
  await idbSet(KEYS.SYNC_STATE, state)
}

export async function loadSettingsWithMeta(): Promise<{ settings: UserSettings; isCustom: boolean }> {
  const stored = await idbGet<Partial<UserSettings>>(KEYS.SETTINGS)
  if (!stored) return { settings: { ...DEFAULT_SETTINGS }, isCustom: false }
  return { settings: { ...DEFAULT_SETTINGS, ...stored }, isCustom: true }
}

export async function loadSettings(): Promise<UserSettings> {
  const { settings } = await loadSettingsWithMeta()
  return settings
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await idbSet(KEYS.SETTINGS, settings)
}

export async function loadCachedTweets(): Promise<TweetItem[]> {
  const stored = await idbGet<TweetItem[]>(KEYS.CACHED_TWEETS)
  return Array.isArray(stored) ? stored : []
}

export async function saveCachedTweets(tweets: TweetItem[]): Promise<void> {
  await idbSet(KEYS.CACHED_TWEETS, tweets)
}
