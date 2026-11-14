import {
  Check,
  ExternalLink,
  FileUp,
  Filter,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'
import { STARTER_CREATORS } from '../data/starterCreators'
import {
  enrichCandidates,
  extractCandidates,
  fetchBackendTweets,
  fetchDemoTweets,
  ingestTweetsToBackend,
} from '../services/api'
import type {
  CandidateWord,
  FilterTier,
  StarterCreator,
  SyncStateDocument,
  TweetItem,
  UserSettings,
  VocabCard,
} from '../types/vocab'

interface IngestConsoleProps {
  tweets: TweetItem[]
  syncState: SyncStateDocument
  settings: UserSettings
  creators: StarterCreator[]
  backendOnline: boolean
  onUpdateTweets: (tweets: TweetItem[]) => void
  onAddCards: (cards: VocabCard[], ignoredFromLlm: string[], analyzedTweetIds: string[]) => void
  onMarkKnownWord: (word: string) => void
  onGoToStudy: () => void
  onOpenSettings: () => void
  onNotify: (msg: string, type?: 'success' | 'error' | 'info') => void
}

const CATEGORY_FILTERS = ['全部', 'AI', '科技', '游戏', '音乐', '生活']

export function IngestConsole({
  tweets,
  syncState,
  settings,
  creators,
  backendOnline,
  onUpdateTweets,
  onAddCards,
  onMarkKnownWord,
  onGoToStudy,
  onOpenSettings,
  onNotify,
}: IngestConsoleProps) {
  const [filterTier, setFilterTier] = useState<FilterTier>(settings.filterTier)
  const [includeSlang, setIncludeSlang] = useState(true)
  const [candidates, setCandidates] = useState<CandidateWord[]>([])
  const [selectedLemmas, setSelectedLemmas] = useState<Set<string>>(new Set())
  const [extracting, setExtracting] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [showPasteBox, setShowPasteBox] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteAuthor, setPasteAuthor] = useState('manual')
  const [creatorCat, setCreatorCat] = useState('全部')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const activeCreators = creators.length > 0 ? creators : STARTER_CREATORS
  const visibleCreators = activeCreators.filter(
    (c) => creatorCat === '全部' || c.category === creatorCat,
  )

  const existingWordsSet = new Set([
    ...syncState.cards.map((c) => c.word.toLowerCase()),
    ...syncState.known_words.map((w) => w.toLowerCase()),
    ...syncState.ignored_words.map((w) => w.toLowerCase()),
  ])

  const mergeIncomingTweets = async (incoming: TweetItem[], syncToBackend = true) => {
    const map = new Map<string, TweetItem>()
    for (const t of tweets) map.set(t.id, t)
    let added = 0
    for (const item of incoming) {
      if (item && item.text?.trim()) {
        const id = item.id || `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        if (!map.has(id)) {
          map.set(id, { ...item, id })
          added += 1
        }
      }
    }
    const merged = Array.from(map.values())
    onUpdateTweets(merged)

    if (syncToBackend && backendOnline && incoming.length > 0) {
      try {
        await ingestTweetsToBackend(incoming)
      } catch {
        // Keep local cache even if backend fails
      }
    }
    return { added, total: merged.length }
  }

  const handlePullFromBackend = async () => {
    setPulling(true)
    try {
      const serverTweets = await fetchBackendTweets()
      const { added, total } = await mergeIncomingTweets(serverTweets, false)
      onNotify(
        serverTweets.length === 0
          ? '本地后端推文池目前为空，请先用 Chrome 插件推送，或点击“加载 7 条示例推文”。'
          : `已同步本地推文池（新增 ${added} 条，当前共 ${total} 条）。`,
        'success',
      )
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : '无法读取本地后端推文池，请确认 start.sh 已启动。',
        'error',
      )
    } finally {
      setPulling(false)
    }
  }

  const handleLoadDemoTweets = async () => {
    const demo = await fetchDemoTweets()
    const { added, total } = await mergeIncomingTweets(demo, true)
    onNotify(`已载入示例推文（新增 ${added} 条，当前共 ${total} 条）。`, 'success')
  }

  const handleParseJsonFile = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as TweetItem[] | { tweets?: TweetItem[] }
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tweets) ? parsed.tweets : []
      if (list.length === 0) {
        onNotify('JSON 文件中没有找到推文列表。', 'error')
        return
      }
      const { added, total } = await mergeIncomingTweets(list, true)
      onNotify(`从文件导入成功：新增 ${added} 条，当前共 ${total} 条推文。`, 'success')
    } catch {
      onNotify('解析 JSON 文件失败，请确认使用的是插件导出的 JSON 格式。', 'error')
    }
  }

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) await handleParseJsonFile(file)
  }

  const handleAddPastedTweet = async () => {
    const clean = pasteText.trim()
    if (clean.length < 10) {
      onNotify('请输入完整的英文推文内容。', 'error')
      return
    }
    const item: TweetItem = {
      id: `paste-${Date.now()}`,
      url: '',
      author_handle: pasteAuthor.trim().replace(/^@/, '') || 'manual',
      author_name: pasteAuthor.trim() || 'Manual Paste',
      text: clean,
      created_at: new Date().toISOString(),
      source_page: 'manual',
    }
    await mergeIncomingTweets([item], true)
    setPasteText('')
    setShowPasteBox(false)
    onNotify('已添加 1 条推文到素材池，点击“提取高性价比生词”即可分析。', 'success')
  }

  const handleExtract = async () => {
    if (tweets.length === 0) {
      onNotify('当前推文池为空，请先拉取插件推文或加载示例推文。', 'error')
      return
    }
    if (!backendOnline) {
      onNotify('本地 Python NLP 后端未连接（127.0.0.1:8765），请先运行 start.sh 启动服务。', 'error')
      return
    }

    setExtracting(true)
    try {
      const res = await extractCandidates({
        tweets,
        filter_tier: filterTier,
        known_words: [...syncState.known_words, ...syncState.cards.map((c) => c.word)],
        ignored_words: syncState.ignored_words,
        max_candidates: 60,
        include_slang: includeSlang,
      })

      const filtered = res.candidates.filter((c) => !existingWordsSet.has(c.lemma.toLowerCase()))
      setCandidates(filtered)
      const top15 = new Set(filtered.slice(0, 15).map((c) => c.lemma))
      setSelectedLemmas(top15)
      onNotify(
        `已从 ${res.total_tweets_analyzed} 条推文中筛选出 ${filtered.length} 个高性价比候选词，并默认勾选前 ${top15.size} 个。`,
        'success',
      )
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '生词提取失败', 'error')
    } finally {
      setExtracting(false)
    }
  }

  const toggleCandidate = (lemma: string) => {
    setSelectedLemmas((prev) => {
      const next = new Set(prev)
      if (next.has(lemma)) next.delete(lemma)
      else next.add(lemma)
      return next
    })
  }

  const handleSkipAsKnown = (lemma: string) => {
    onMarkKnownWord(lemma)
    setCandidates((prev) => prev.filter((c) => c.lemma !== lemma))
    setSelectedLemmas((prev) => {
      const next = new Set(prev)
      next.delete(lemma)
      return next
    })
  }

  const handleEnrichSelected = async () => {
    const selected = candidates.filter((c) => selectedLemmas.has(c.lemma))
    if (selected.length === 0) {
      onNotify('请至少勾选 1 个候选词汇。', 'error')
      return
    }

    setEnriching(true)
    try {
      const res = await enrichCandidates({
        candidates: selected,
        settings,
        autoSave: true,
      })
      const tweetIds = new Set<string>()
      selected.forEach((c) => c.sample_tweets.forEach((s) => tweetIds.add(s.tweet_id)))
      onAddCards(res.cards, res.skipped_ignored, Array.from(tweetIds))

      const createdSet = new Set(res.cards.map((c) => c.word.toLowerCase()))
      const ignoredSet = new Set(res.skipped_ignored.map((w) => w.toLowerCase()))
      setCandidates((prev) =>
        prev.filter((c) => !createdSet.has(c.lemma.toLowerCase()) && !ignoredSet.has(c.lemma.toLowerCase())),
      )
      setSelectedLemmas(new Set())
      onNotify(
        `成功生成 ${res.cards.length} 张语境词卡（自动剔除无意义词 ${res.skipped_ignored.length} 个），已加入“今日复习”！`,
        'success',
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : '词卡生成失败'
      onNotify(msg, 'error')
      if (msg.includes('API Key')) {
        onOpenSettings()
      }
    } finally {
      setEnriching(false)
    }
  }

  return (
    <section className="section-stack" aria-label="推文采集与 AI 选词">
      {/* Step 1: Tweet Pool */}
      <div className="panel-card">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">1. X 推文素材池（当前共 {tweets.length} 条）</h2>
            <p className="panel-subtitle">
              使用 Chrome 插件浏览或自动滚动抓取后点“推送”，或者直接拖入插件导出的 JSON。
            </p>
          </div>
          <div className="toolbar-row">
            <button
              id="btn-pull-tweets"
              type="button"
              className="btn btn-sm"
              disabled={pulling}
              onClick={handlePullFromBackend}
            >
              <RefreshCw size={14} />
              {pulling ? '同步中...' : '拉取插件队列'}
            </button>
            <button
              id="btn-load-demo-tweets"
              type="button"
              className="btn btn-sm"
              onClick={handleLoadDemoTweets}
            >
              <Sparkles size={14} />
              加载 7 条示例推文
            </button>
            <button
              id="btn-toggle-paste"
              type="button"
              className="btn btn-sm"
              onClick={() => setShowPasteBox((v) => !v)}
            >
              粘贴单条推文
            </button>
            {tweets.length > 0 && (
              <button
                id="btn-clear-tweets-pool"
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  onUpdateTweets([])
                  setCandidates([])
                }}
              >
                <Trash2 size={14} />
                清空素材池
              </button>
            )}
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (file) await handleParseJsonFile(file)
            e.target.value = ''
          }}
        />

        <div
          className={`dropzone ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click()
          }}
        >
          <FileUp size={18} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          将 Chrome 插件导出的 <code>x-tweets-*.json</code> 拖到此处，或点击选择文件导入
        </div>

        {showPasteBox && (
          <div className="paste-box">
            <input
              id="input-paste-author"
              className="input"
              placeholder="推文作者 handle（可选，如 karpathy）"
              value={pasteAuthor}
              onChange={(e) => setPasteAuthor(e.target.value)}
            />
            <textarea
              id="input-paste-tweet"
              className="textarea"
              rows={3}
              placeholder="粘贴一段英文 X 推文内容..."
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="toolbar-row">
              <button id="btn-save-pasted-tweet" type="button" className="btn btn-primary btn-sm" onClick={handleAddPastedTweet}>
                加入素材池
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setShowPasteBox(false)}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Step 2: NLP Filter + LLM Batch Enrichment */}
      <div className="panel-card">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">2. 分层词频过滤 & AI 批量生成词卡</h2>
            <p className="panel-subtitle">
              本地零成本剔除已认识的基础词与无用噪声，仅将高价值候选词交给 {settings.llmProvider === 'gemini' ? 'Gemini' : 'DeepSeek'} 解析。
            </p>
          </div>
          <div className="toolbar-row">
            <button
              id="btn-open-llm-settings"
              type="button"
              className="btn btn-sm"
              onClick={onOpenSettings}
            >
              <Settings size={14} />
              模型配置与连通测试 ({settings.llmProvider === 'gemini' ? settings.geminiModel : settings.llmModel})
            </button>
            {syncState.cards.length > 0 && (
              <button id="btn-jump-study" type="button" className="btn btn-sm" onClick={onGoToStudy}>
                前往「今日复习」({syncState.cards.length} 张)
              </button>
            )}
          </div>
        </div>

        <div className="filter-controls">
          <div className="control-group">
            <label htmlFor="select-filter-tier">过滤基础词库：</label>
            <select
              id="select-filter-tier"
              className="select"
              value={filterTier}
              onChange={(e) => setFilterTier(e.target.value as FilterTier)}
            >
              <option value="strict_1200">核心 1200 词（最严格保留初中级词）</option>
              <option value="basic_2000">基础 2000 词（推荐四级以下起步）</option>
              <option value="cet4_3500">四级 3500 词（进阶词汇筛选）</option>
            </select>
          </div>

          <label className="control-group" style={{ cursor: 'pointer' }}>
            <input
              id="checkbox-include-slang"
              type="checkbox"
              checked={includeSlang}
              onChange={(e) => setIncludeSlang(e.target.checked)}
            />
            <span>包含 X 常见缩写与游戏/AI俚语 (ngl / tbh / nerf)</span>
          </label>

          <button
            id="btn-extract-candidates"
            type="button"
            className="btn btn-primary"
            disabled={extracting || tweets.length === 0}
            onClick={handleExtract}
          >
            <Filter size={15} />
            {extracting ? '正在分词与词频计算...' : '提取高性价比生词'}
          </button>
        </div>

        {candidates.length > 0 && (
          <>
            <div className="panel-header" style={{ marginBottom: 12 }}>
              <div className="toolbar-row">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setSelectedLemmas(new Set(candidates.slice(0, 15).map((c) => c.lemma)))}
                >
                  仅选前 15 个最值词
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setSelectedLemmas(new Set(candidates.map((c) => c.lemma)))}
                >
                  全选 ({candidates.length})
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setSelectedLemmas(new Set())}>
                  取消全选
                </button>
              </div>

              <button
                id="btn-enrich-selected"
                type="button"
                className="btn btn-sage"
                disabled={enriching || selectedLemmas.size === 0}
                onClick={handleEnrichSelected}
              >
                <Sparkles size={15} />
                {enriching
                  ? '大模型解析中...'
                  : `生成语境词卡（已选 ${selectedLemmas.size} 个）`}
              </button>
            </div>

            <div className="candidate-list">
              {candidates.map((c) => {
                const isSelected = selectedLemmas.has(c.lemma)
                const sample = c.sample_tweets[0]
                return (
                  <div key={c.lemma} className={`candidate-row ${isSelected ? 'selected' : ''}`}>
                    <input
                      type="checkbox"
                      aria-label={`选择词汇 ${c.lemma}`}
                      checked={isSelected}
                      onChange={() => toggleCandidate(c.lemma)}
                      style={{ marginTop: 6 }}
                    />
                    <div>
                      <div className="candidate-word-title">
                        <span className="candidate-lemma">{c.lemma}</span>
                        <span className="tag">{c.pos}</span>
                        {c.is_phrase && <span className="tag collocation">短语搭配</span>}
                        {c.is_slang_seed && <span className="tag slang">网感俚语</span>}
                        <span className="tag tabular">出现 {c.corpus_count} 次 · Zipf {c.zipf_score}</span>
                      </div>
                      {c.slang_hint && (
                        <div style={{ fontSize: 12.5, color: 'var(--accent)', fontWeight: 500 }}>
                          本地提示：{c.slang_hint}
                        </div>
                      )}
                      {sample && (
                        <p className="candidate-tweet-preview">
                          @{sample.author_handle}: {sample.text}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleSkipAsKnown(c.lemma)}
                      title="已认识此词，以后不再推荐"
                    >
                      <Check size={14} />
                      已认识
                    </button>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* Curated Non-Political Starter Creators */}
      <div className="panel-card">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">入门精选 X 英语博主目录（无政治干扰）</h2>
            <p className="panel-subtitle">
              覆盖 AI、科技、游戏、音乐与生活方式。建议在 X 中将这些账号建为一个私有 List，配合 Chrome 插件刷推采集。
            </p>
          </div>
        </div>

        <div className="chip-row">
          {CATEGORY_FILTERS.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`chip ${creatorCat === cat ? 'active' : ''}`}
              onClick={() => setCreatorCat(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="creators-grid">
          {visibleCreators.map((creator) => (
            <div key={creator.handle} className="creator-card">
              <div className="creator-card-top">
                <span className="creator-name">{creator.name}</span>
                <span className="tag">
                  {creator.category} · {creator.difficulty}
                </span>
              </div>
              <a
                className="creator-handle"
                href={creator.url}
                target="_blank"
                rel="noreferrer"
              >
                @{creator.handle} <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
              </a>
              <p className="creator-desc">{creator.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
