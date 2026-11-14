import { BookOpen, Cloud, FolderKanban, Layers, Settings, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IngestConsole } from './components/IngestConsole'
import { SettingsModal } from './components/SettingsModal'
import { StatsAndExport } from './components/StatsAndExport'
import { StudyView } from './components/StudyView'
import { STARTER_CREATORS } from './data/starterCreators'
import {
  checkBackendHealth,
  fetchDemoCards,
  fetchStarterCreators,
  syncObsidianVault,
  syncWithBackendStore,
} from './services/api'
import { syncObsidianRest } from './services/obsidianRest'
import { mergeSyncStates, normalizeWordKey, syncWithGoogleDrive } from './services/googleDrive'
import {
  loadCachedTweets,
  loadLocalSyncState,
  loadSettingsWithMeta,
  saveCachedTweets,
  saveLocalSyncState,
  saveSettings,
} from './services/localDb'
import { buildDueQueue, scheduleCardReview } from './services/srs'
import {
  createEmptySyncState,
  DEFAULT_SETTINGS,
  type RatingGrade,
  type StarterCreator,
  type SyncStateDocument,
  type TweetItem,
  type UserSettings,
  type VocabCard,
} from './types/vocab'
import { formatRelativeTimeZh } from './utils/textHelpers'

type ActiveTab = 'study' | 'ingest' | 'stats'

interface BannerNotice {
  text: string
  type: 'success' | 'error' | 'info'
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('study')
  const [syncState, setSyncState] = useState<SyncStateDocument>(() => createEmptySyncState())
  const [settings, setSettings] = useState<UserSettings>(() => ({ ...DEFAULT_SETTINGS }))
  const [tweets, setTweets] = useState<TweetItem[]>([])
  const [creators, setCreators] = useState<StarterCreator[]>(STARTER_CREATORS)
  const [backendOnline, setBackendOnline] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [extraNewAllowed, setExtraNewAllowed] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [syncingDrive, setSyncingDrive] = useState(false)
  const [driveError, setDriveError] = useState(false)
  const [notice, setNotice] = useState<BannerNotice | null>(null)
  const latestStateRef = useRef(syncState)

  useEffect(() => {
    latestStateRef.current = syncState
  }, [syncState])

  const notify = useCallback((text: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotice({ text, type })
  }, [])

  const persistState = useCallback(
    (updater: (prev: SyncStateDocument) => SyncStateDocument, syncBackend = false) => {
      setSyncState((prev) => {
        const next = updater(prev)
        latestStateRef.current = next
        void saveLocalSyncState(next)
        if (syncBackend) {
          void syncWithBackendStore(next)
        }
        return next
      })
    },
    [],
  )

  useEffect(() => {
    let active = true
    async function bootstrap() {
      const [localState, { settings: localSettings, isCustom }, localTweets, health, creatorList] = await Promise.all([
        loadLocalSyncState(),
        loadSettingsWithMeta(),
        loadCachedTweets(),
        checkBackendHealth(),
        fetchStarterCreators(),
      ])

      if (!active) return
      const effectiveSettings: UserSettings =
        !isCustom && health.online
          ? {
              ...localSettings,
              llmProvider: health.default_provider === 'gemini' ? 'gemini' : 'openai_compatible',
              llmBaseUrl: health.default_base_url || localSettings.llmBaseUrl,
              llmModel:
                health.default_provider === 'gemini'
                  ? localSettings.llmModel
                  : health.default_model || localSettings.llmModel,
              geminiModel:
                health.default_provider === 'gemini'
                  ? health.default_model || localSettings.geminiModel
                  : localSettings.geminiModel,
              filterTier: health.default_filter_tier || localSettings.filterTier,
            }
          : localSettings

      setSettings(effectiveSettings)
      setTweets(localTweets)
      setBackendOnline(health.online)
      setCreators(creatorList)

      if (localState.cards.length === 0 && health.online) {
        const remoteLocal = await syncWithBackendStore(localState)
        if (active && remoteLocal && remoteLocal.cards.length > 0) {
          setSyncState(remoteLocal)
          await saveLocalSyncState(remoteLocal)
          setHydrated(true)
          return
        }
      }

      setSyncState(localState)
      setHydrated(true)
    }

    void bootstrap()
    return () => {
      active = false
    }
  }, [])

  const dueQueue = useMemo(
    () =>
      buildDueQueue(syncState, {
        dailyNewLimit: settings.dailyNewLimit,
        extraNewAllowed,
      }),
    [syncState, settings.dailyNewLimit, extraNewAllowed],
  )

  const handleRateCard = useCallback(
    (card: VocabCard, rating: RatingGrade) => {
      const { updatedCard, logEntry } = scheduleCardReview(card, rating)
      persistState(
        (prev) => ({
          ...prev,
          updated_at: updatedCard.updated_at,
          cards: prev.cards.map((c) => (c.id === card.id ? updatedCard : c)),
          review_logs: [...prev.review_logs, logEntry],
        }),
        backendOnline,
      )
    },
    [persistState, backendOnline],
  )

  const handleMarkKnown = useCallback(
    (cardOrWord: VocabCard | string) => {
      const wordKey = normalizeWordKey(typeof cardOrWord === 'string' ? cardOrWord : cardOrWord.word)
      persistState(
        (prev) => ({
          ...prev,
          updated_at: new Date().toISOString(),
          known_words: Array.from(new Set([...prev.known_words.map(normalizeWordKey), wordKey])).sort(),
        }),
        backendOnline,
      )
      notify(`已将 “${wordKey}” 标为熟知词，今后不再重复抽取。`, 'info')
    },
    [persistState, backendOnline, notify],
  )

  const handleIgnoreCard = useCallback(
    (card: VocabCard) => {
      const wordKey = normalizeWordKey(card.word)
      persistState(
        (prev) => ({
          ...prev,
          updated_at: new Date().toISOString(),
          ignored_words: Array.from(new Set([...prev.ignored_words.map(normalizeWordKey), wordKey])).sort(),
        }),
        backendOnline,
      )
      notify(`已屏蔽 “${card.word}”。`, 'info')
    },
    [persistState, backendOnline, notify],
  )

  const handleDeleteCard = useCallback(
    (cardId: string) => {
      persistState((prev) => ({
        ...prev,
        updated_at: new Date().toISOString(),
        cards: prev.cards.filter((c) => c.id !== cardId),
      }))
      notify('已移除该词卡。', 'info')
    },
    [persistState, notify],
  )

  const handleRestoreWord = useCallback(
    (word: string) => {
      const key = normalizeWordKey(word)
      persistState(
        (prev) => ({
          ...prev,
          updated_at: new Date().toISOString(),
          known_words: prev.known_words.filter((w) => normalizeWordKey(w) !== key),
          ignored_words: prev.ignored_words.filter((w) => normalizeWordKey(w) !== key),
        }),
        backendOnline,
      )
      notify(`已恢复 “${word}”，后续提取或复习可重新出现。`, 'info')
    },
    [persistState, backendOnline, notify],
  )

  const handleLoadDemoCards = useCallback(async () => {
    const demoCards = await fetchDemoCards()
    persistState(
      (prev) => {
        const existing = new Set(prev.cards.map((c) => normalizeWordKey(c.word)))
        const toAdd = demoCards.filter((c) => !existing.has(normalizeWordKey(c.word)))
        return {
          ...prev,
          updated_at: new Date().toISOString(),
          cards: [...prev.cards, ...toAdd],
        }
      },
      backendOnline,
    )
    notify(`已加载 ${demoCards.length} 张 X 推文精选词卡，现在即可开始记忆！`, 'success')
  }, [persistState, backendOnline, notify])

  const handleAddCards = useCallback(
    (newCards: VocabCard[], ignoredFromLlm: string[], analyzedTweetIds: string[]) => {
      const currentCards = latestStateRef.current.cards
      const existingWordSnapshot = new Set(currentCards.map((c) => normalizeWordKey(c.word)))
      const cardsForObsidian = [
        ...currentCards,
        ...newCards.filter((c) => !existingWordSnapshot.has(normalizeWordKey(c.word))),
      ]

      persistState(
        (prev) => {
          const existingWords = new Set(prev.cards.map((c) => normalizeWordKey(c.word)))
          const dedupedNew = newCards.filter((c) => !existingWords.has(normalizeWordKey(c.word)))
          const mergedIgnored = Array.from(
            new Set([
              ...prev.ignored_words.map(normalizeWordKey),
              ...ignoredFromLlm.map(normalizeWordKey),
            ]),
          ).sort()
          const mergedTweets = Array.from(
            new Set([...prev.processed_tweet_ids, ...analyzedTweetIds]),
          ).sort()

          return {
            ...prev,
            updated_at: new Date().toISOString(),
            cards: [...prev.cards, ...dedupedNew],
            ignored_words: mergedIgnored,
            processed_tweet_ids: mergedTweets,
          }
        },
        backendOnline,
      )

      if (settings.obsidianAutoSync && cardsForObsidian.length > 0 && newCards.length > 0) {
        const subfolder = settings.obsidianSubfolder.trim() || 'X-Vocab'
        const srDeckTag = settings.obsidianSrDeckTag || '#flashcards/x-vocab'
        const srCardStyle = settings.obsidianSrCardStyle || 'multiline'
        const srSubdeckByCategory = settings.obsidianSrSubdeckByCategory ?? false
        const srSeedProgress = settings.obsidianSrSyncProgress ?? true
        const srIncludeAudio = settings.obsidianSrAudio ?? true
        const srAudioAutoplay = settings.obsidianSrAudioAutoplay ?? true
        const ttsAccent = settings.ttsAccent || 'en-US'

        if (
          settings.obsidianSyncMode === 'rest_api' &&
          settings.obsidianRestUrl.trim() &&
          settings.obsidianRestApiKey.trim()
        ) {
          void syncObsidianRest({
            cards: cardsForObsidian,
            apiUrl: settings.obsidianRestUrl.trim(),
            apiKey: settings.obsidianRestApiKey.trim(),
            subfolder,
            includeFlashcards: settings.obsidianIncludeFlashcards,
            srDeckTag,
            srCardStyle,
            srSubdeckByCategory,
            srSeedProgress,
            srIncludeAudio,
            srAudioAutoplay,
            ttsAccent,
            backendOnline,
          }).catch(() => undefined)
        } else if (
          settings.obsidianSyncMode !== 'rest_api' &&
          settings.obsidianVaultPath.trim() &&
          backendOnline
        ) {
          void syncObsidianVault({
            cards: cardsForObsidian,
            vaultPath: settings.obsidianVaultPath.trim(),
            subfolder,
            includeFlashcards: settings.obsidianIncludeFlashcards,
            srDeckTag,
            srCardStyle,
            srSubdeckByCategory,
            srSeedProgress,
            srIncludeAudio,
            srAudioAutoplay,
            ttsAccent,
          }).catch(() => undefined)
        }
      }
    },
    [
      persistState,
      backendOnline,
      settings.obsidianAutoSync,
      settings.obsidianSyncMode,
      settings.obsidianRestUrl,
      settings.obsidianRestApiKey,
      settings.obsidianVaultPath,
      settings.obsidianSubfolder,
      settings.obsidianIncludeFlashcards,
      settings.obsidianSrDeckTag,
      settings.obsidianSrCardStyle,
      settings.obsidianSrSubdeckByCategory,
      settings.obsidianSrSyncProgress,
      settings.obsidianSrAudio,
      settings.obsidianSrAudioAutoplay,
      settings.ttsAccent,
    ],
  )

  const handleUpdateTweets = useCallback((nextTweets: TweetItem[]) => {
    setTweets(nextTweets)
    void saveCachedTweets(nextTweets)
  }, [])

  const handleSaveSettings = useCallback(
    (next: UserSettings) => {
      setSettings(next)
      void saveSettings(next)
      notify('设置已保存至本地浏览器。', 'success')
    },
    [notify],
  )

  const handleToggleShowContext = useCallback(() => {
    setSettings((prev) => {
      const next = { ...prev, showContextOnFront: !prev.showContextOnFront }
      void saveSettings(next)
      return next
    })
  }, [])

  const handleSyncDrive = useCallback(async () => {
    if (!settings.googleClientId.trim()) {
      setSettingsOpen(true)
      notify('请先填写您个人的 Google OAuth Client ID 后再同步云盘。', 'info')
      return
    }
    setSyncingDrive(true)
    setDriveError(false)
    try {
      const result = await syncWithGoogleDrive(syncState, {
        clientId: settings.googleClientId,
        knownFileId: settings.driveFileId || undefined,
      })
      const merged = mergeSyncStates(syncState, result.mergedState)
      setSyncState(merged)
      await saveLocalSyncState(merged)
      if (backendOnline) {
        void syncWithBackendStore(merged)
      }
      const nextSettings: UserSettings = {
        ...settings,
        driveFileId: result.fileId,
        lastSyncedAt: result.syncedAt,
      }
      setSettings(nextSettings)
      await saveSettings(nextSettings)
      notify(`Google Drive 同步完成！当前云端与本地共 ${merged.cards.length} 张词卡。`, 'success')
    } catch (err) {
      setDriveError(true)
      notify(err instanceof Error ? err.message : 'Google Drive 同步失败', 'error')
    } finally {
      setSyncingDrive(false)
    }
  }, [settings, syncState, backendOnline, notify])

  const syncDotClass = syncingDrive
    ? 'sync-dot syncing'
    : driveError
      ? 'sync-dot error'
      : settings.lastSyncedAt
        ? 'sync-dot connected'
        : 'sync-dot'

  const syncPillText = syncingDrive
    ? '同步中...'
    : settings.lastSyncedAt
      ? `云盘 · ${formatRelativeTimeZh(settings.lastSyncedAt)}`
      : settings.googleClientId.trim()
        ? '同步 Drive'
        : '仅本地保存'

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              X
            </div>
            <div>
              <h1 className="brand-title">LearnEnglishFromX</h1>
              <span className="brand-sub">刷 X 学实用英语 · FSRS 记忆曲线</span>
            </div>
          </div>

          <nav className="nav-tabs" aria-label="主功能导航">
            <button
              id="tab-study"
              type="button"
              className={`nav-tab ${activeTab === 'study' ? 'active' : ''}`}
              onClick={() => setActiveTab('study')}
            >
              <BookOpen size={15} />
              今日复习
              {dueQueue.dueCards.length > 0 && (
                <span className="nav-badge">{dueQueue.dueCards.length}</span>
              )}
            </button>

            <button
              id="tab-ingest"
              type="button"
              className={`nav-tab ${activeTab === 'ingest' ? 'active' : ''}`}
              onClick={() => setActiveTab('ingest')}
            >
              <FolderKanban size={15} />
              采集选词
            </button>

            <button
              id="tab-stats"
              type="button"
              className={`nav-tab ${activeTab === 'stats' ? 'active' : ''}`}
              onClick={() => setActiveTab('stats')}
            >
              <Layers size={15} />
              词库与同步
            </button>
          </nav>

          <div className="topbar-actions">
            <button
              id="btn-sync-drive"
              type="button"
              className="btn sync-pill"
              disabled={syncingDrive}
              onClick={handleSyncDrive}
              title={
                settings.googleClientId.trim()
                  ? '点击与 Google Drive 双向合并同步'
                  : '未绑定 Google Drive，点击前往配置'
              }
            >
              <span className={syncDotClass} />
              <Cloud size={14} />
              <span>{syncPillText}</span>
            </button>

            <button
              id="btn-open-settings"
              type="button"
              className="btn icon-btn"
              onClick={() => setSettingsOpen(true)}
              aria-label="打开设置"
              title="大模型 Key、Google Drive OAuth 与学习偏好设置"
            >
              <Settings size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className="main-content">
        {notice && (
          <div className={`notice-banner ${notice.type}`} role="status">
            <span>{notice.text}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: 4 }}
              onClick={() => setNotice(null)}
              aria-label="关闭提示"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {!hydrated ? (
          <div className="empty-paper">正在加载本地词库与记忆队列...</div>
        ) : activeTab === 'study' ? (
          <StudyView
            dueQueue={dueQueue}
            totalCardsCount={syncState.cards.length}
            settings={settings}
            isModalOpen={settingsOpen}
            onRateCard={handleRateCard}
            onMarkKnown={handleMarkKnown}
            onIgnoreCard={handleIgnoreCard}
            onLoadDemoCards={handleLoadDemoCards}
            onAddExtraNew={() => setExtraNewAllowed((n) => n + 5)}
            onToggleShowContext={handleToggleShowContext}
            onGoToIngest={() => setActiveTab('ingest')}
          />
        ) : activeTab === 'ingest' ? (
          <IngestConsole
            tweets={tweets}
            syncState={syncState}
            settings={settings}
            creators={creators}
            backendOnline={backendOnline}
            onUpdateTweets={handleUpdateTweets}
            onAddCards={handleAddCards}
            onMarkKnownWord={handleMarkKnown}
            onGoToStudy={() => setActiveTab('study')}
            onOpenSettings={() => setSettingsOpen(true)}
            onNotify={notify}
          />
        ) : (
          <StatsAndExport
            syncState={syncState}
            settings={settings}
            backendOnline={backendOnline}
            syncingDrive={syncingDrive}
            onSyncDrive={handleSyncDrive}
            onOpenSettings={() => setSettingsOpen(true)}
            onDeleteCard={handleDeleteCard}
            onMarkKnown={handleMarkKnown}
            onRestoreKnownOrIgnored={handleRestoreWord}
            onImportStateBackup={(merged) => {
              persistState(() => merged, backendOnline)
            }}
            onMergePulledCards={(updatedCards) => {
              persistState((prev) => {
                const byId = new Map(updatedCards.map((c) => [c.id, c]))
                const byWord = new Map(updatedCards.map((c) => [c.word.trim().toLowerCase(), c]))
                return {
                  ...prev,
                  cards: prev.cards.map(
                    (existing) =>
                      byId.get(existing.id) ?? byWord.get(existing.word.trim().toLowerCase()) ?? existing,
                  ),
                }
              }, backendOnline)
            }}
            onNotify={notify}
          />
        )}
      </main>

      {settingsOpen && (
        <SettingsModal
          open={settingsOpen}
          settings={settings}
          backendOnline={backendOnline}
          onBackendOnline={() => setBackendOnline(true)}
          onSave={handleSaveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
