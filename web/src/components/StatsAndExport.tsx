import { Cloud, Download, FileText, FolderUp, Search, Settings, Trash2, Volume2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { exportApkgFile, exportObsidianZip, syncObsidianVault } from '../services/api'
import { mergeSyncStates } from '../services/googleDrive'
import { formatIntervalZh, getCardStageLabel, toLocalDateKey } from '../services/srs'
import type { SyncStateDocument, UserSettings, VocabCard } from '../types/vocab'
import {
  buildOfflineObsidianMarkdown,
  categoryLabelZh,
  formatRelativeTimeZh,
  speakEnglishText,
} from '../utils/textHelpers'

interface StatsAndExportProps {
  syncState: SyncStateDocument
  settings: UserSettings
  backendOnline: boolean
  syncingDrive: boolean
  onSyncDrive: () => Promise<void>
  onOpenSettings: () => void
  onDeleteCard: (cardId: string) => void
  onMarkKnown: (card: VocabCard) => void
  onRestoreKnownOrIgnored: (word: string) => void
  onImportStateBackup: (merged: SyncStateDocument) => void
  onNotify: (msg: string, type?: 'success' | 'error' | 'info') => void
}

export function StatsAndExport({
  syncState,
  settings,
  backendOnline,
  syncingDrive,
  onSyncDrive,
  onOpenSettings,
  onDeleteCard,
  onMarkKnown,
  onRestoreKnownOrIgnored,
  onImportStateBackup,
  onNotify,
}: StatsAndExportProps) {
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState<'all' | 'new' | 'learning' | 'mastered'>('all')
  const [deckName, setDeckName] = useState('LearnEnglishFromX')
  const [exportingApkg, setExportingApkg] = useState(false)
  const [syncingObsidian, setSyncingObsidian] = useState(false)
  const [exportingObsidianZip, setExportingObsidianZip] = useState(false)
  const [flashcardOverride, setFlashcardOverride] = useState<boolean | null>(null)
  const includeFlashcards = flashcardOverride ?? settings.obsidianIncludeFlashcards
  const [showSkipped, setShowSkipped] = useState(false)
  const backupInputRef = useRef<HTMLInputElement | null>(null)

  const [now] = useState(() => new Date())
  const todayKey = toLocalDateKey(now)
  const reviewedToday = syncState.review_logs.filter((l) => {
    const d = new Date(l.reviewed_at)
    return !Number.isNaN(d.getTime()) && toLocalDateKey(d) === todayKey
  }).length

  const masteredCount = syncState.cards.filter((c) => getCardStageLabel(c).tone === 'mastered').length

  const filteredCards = useMemo(() => {
    const q = search.trim().toLowerCase()
    return syncState.cards.filter((c) => {
      if (stageFilter !== 'all' && getCardStageLabel(c).tone !== stageFilter) return false
      if (!q) return true
      return (
        c.word.toLowerCase().includes(q) ||
        c.meaning_zh.toLowerCase().includes(q) ||
        c.author_handle.toLowerCase().includes(q)
      )
    })
  }, [syncState.cards, search, stageFilter])

  const handleExportApkg = async () => {
    if (syncState.cards.length === 0) {
      onNotify('当前词库为空，请先加载示例词卡或采集生成后再导出。', 'error')
      return
    }
    if (!backendOnline) {
      onNotify('导出 Anki .apkg 文件需要本地 Python 后端运行（请确认已启动 start.sh）。', 'error')
      return
    }
    setExportingApkg(true)
    try {
      const cleanDeck = deckName.trim() || 'LearnEnglishFromX'
      const blob = await exportApkgFile(syncState.cards, cleanDeck)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${cleanDeck}.apkg`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      onNotify(`已导出 ${syncState.cards.length} 张词卡到 ${cleanDeck}.apkg，可直接导入 Anki / AnkiDroid！`, 'success')
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '导出 .apkg 失败', 'error')
    } finally {
      setExportingApkg(false)
    }
  }

  const handleSyncObsidian = async () => {
    if (syncState.cards.length === 0) {
      onNotify('当前词库为空，请先加载示例词卡或采集生成后再写入 Obsidian。', 'error')
      return
    }
    if (!backendOnline) {
      onNotify(
        '直写本地 Obsidian Vault 文件夹需要 Python 后端运行（请确认已启动 start.sh）；离线时请点击右侧导出 Markdown。',
        'error',
      )
      return
    }
    if (!settings.obsidianVaultPath.trim()) {
      onOpenSettings()
      onNotify('请先在设置中填写您的本机 Obsidian Vault 文件夹路径。', 'info')
      return
    }
    setSyncingObsidian(true)
    try {
      const result = await syncObsidianVault({
        cards: syncState.cards,
        vaultPath: settings.obsidianVaultPath.trim(),
        subfolder: settings.obsidianSubfolder.trim() || 'X-Vocab',
        includeFlashcards,
      })
      onNotify(
        `已写入 ${result.written_count} 个 Obsidian Markdown 文件到 ${result.target_dir}（保留个人笔记与复习注释）。`,
        'success',
      )
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '写入 Obsidian Vault 失败', 'error')
    } finally {
      setSyncingObsidian(false)
    }
  }

  const handleExportObsidianZip = async () => {
    if (syncState.cards.length === 0) {
      onNotify('当前词库为空，请先加载示例词卡或采集生成后再导出。', 'error')
      return
    }
    setExportingObsidianZip(true)
    try {
      if (backendOnline) {
        const blob = await exportObsidianZip({
          cards: syncState.cards,
          subfolder: settings.obsidianSubfolder.trim() || 'X-Vocab',
          includeFlashcards,
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'LearnEnglishFromX-Obsidian.zip'
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        onNotify(
          `已导出 ${syncState.cards.length} 张词卡 Markdown 笔记与总览到 LearnEnglishFromX-Obsidian.zip，解压放入 Obsidian Vault 即可！`,
          'success',
        )
      } else {
        const markdown = buildOfflineObsidianMarkdown(syncState.cards, includeFlashcards)
        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'LearnEnglishFromX-Obsidian.md'
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        onNotify(
          '本地后端未连接，已离线导出汇总笔记 LearnEnglishFromX-Obsidian.md，可直接放入 Obsidian 仓库。',
          'success',
        )
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '导出 Obsidian Markdown 失败', 'error')
    } finally {
      setExportingObsidianZip(false)
    }
  }

  const handleExportJsonBackup = () => {
    const payload = JSON.stringify(syncState, null, 2)
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `learn-english-from-x-backup-${todayKey}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    onNotify('已下载完整学习进度 JSON 备份。', 'success')
  }

  const handleImportJsonBackup = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text()) as SyncStateDocument
      if (!raw || !Array.isArray(raw.cards)) {
        onNotify('备份文件格式无效：缺少 cards 列表。', 'error')
        return
      }
      const merged = mergeSyncStates(syncState, raw)
      onImportStateBackup(merged)
      onNotify(`已合并导入备份：当前共 ${merged.cards.length} 张词卡。`, 'success')
    } catch {
      onNotify('导入学习备份失败，请确认文件是合法 JSON。', 'error')
    }
  }

  const combinedSkipped = Array.from(new Set([...syncState.known_words, ...syncState.ignored_words])).sort()

  return (
    <section className="section-stack" aria-label="词库管理、Google Drive 同步与 Anki 导出">
      {/* Metrics Strip */}
      <div className="metrics-strip">
        <div className="metric-box">
          <span className="metric-label">词库总词数</span>
          <div className="metric-value">{syncState.cards.length}</div>
        </div>
        <div className="metric-box">
          <span className="metric-label">已巩固 (间隔 ≥ 7天)</span>
          <div className="metric-value" style={{ color: 'var(--sage)' }}>
            {masteredCount}
          </div>
        </div>
        <div className="metric-box">
          <span className="metric-label">今日复习次数</span>
          <div className="metric-value">{reviewedToday}</div>
        </div>
        <div className="metric-box">
          <span className="metric-label">已过滤熟词/屏蔽</span>
          <div className="metric-value">{combinedSkipped.length}</div>
        </div>
      </div>

      {/* Sync & Export Cards */}
      <div className="split-grid">
        <div className="panel-card">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Google Drive 云端同步</h2>
              <p className="panel-subtitle">
                将进度保存至您个人云盘的 <code>LearnEnglishFromX_Data/vocab_state.json</code>，跨设备合并无冲突。
              </p>
            </div>
          </div>

          <p style={{ fontSize: 13.5, color: 'var(--ink-secondary)', margin: '0 0 16px' }}>
            当前状态：
            {settings.googleClientId.trim() ? (
              <strong>
                已配置 Client ID · 上次同步：{formatRelativeTimeZh(settings.lastSyncedAt)}
              </strong>
            ) : (
              <span>未配置 Google OAuth Client ID（当前进度安全存储在本地浏览器 IndexedDB）</span>
            )}
          </p>

          <div className="toolbar-row">
            <button
              id="btn-drive-sync-panel"
              type="button"
              className="btn btn-primary"
              disabled={syncingDrive}
              onClick={settings.googleClientId.trim() ? onSyncDrive : onOpenSettings}
            >
              <Cloud size={15} />
              {syncingDrive
                ? '正在同步...'
                : settings.googleClientId.trim()
                  ? '立即同步到 Google Drive'
                  : '前往填写 OAuth Client ID'}
            </button>
            {settings.googleClientId.trim() && (
              <button type="button" className="btn" onClick={onOpenSettings}>
                <Settings size={14} />
                修改设置
              </button>
            )}
          </div>
        </div>

        <div className="panel-card">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">导出 Anki 牌组 & 离线备份</h2>
              <p className="panel-subtitle">
                支持一键导出含原推文高亮的 <code>.apkg</code> 牌组，直接导入手机端 AnkiDroid 使用。
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <input
              id="input-deck-name"
              className="input"
              value={deckName}
              onChange={(e) => setDeckName(e.target.value)}
              placeholder="Anki 牌组名称"
              aria-label="Anki 牌组名称"
            />
            <button
              id="btn-export-apkg"
              type="button"
              className="btn btn-sage"
              disabled={exportingApkg || syncState.cards.length === 0}
              onClick={handleExportApkg}
            >
              <Download size={15} />
              {exportingApkg ? '打包中...' : '导出 .apkg'}
            </button>
          </div>

          <input
            ref={backupInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (file) await handleImportJsonBackup(file)
              e.target.value = ''
            }}
          />

          <div className="toolbar-row">
            <button id="btn-export-json" type="button" className="btn btn-sm" onClick={handleExportJsonBackup}>
              <Download size={14} />
              下载 JSON 进度备份
            </button>
            <button
              id="btn-import-json"
              type="button"
              className="btn btn-sm"
              onClick={() => backupInputRef.current?.click()}
            >
              <FolderUp size={14} />
              从 JSON 备份恢复合并
            </button>
          </div>
        </div>
      </div>

      {/* Obsidian Vault Sync & Markdown Export */}
      <div className="panel-card">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Obsidian 知识库连接（Markdown 笔记 + Spaced Repetition 闪卡）</h2>
            <p className="panel-subtitle">
              一词一笔记，附带 YAML 属性（适配 Dataview 看板）、<code>[[@博主]]</code> 双链与原推文 <code>==高亮==</code>；重复同步自动保留您的个人笔记与复习进度注释。
            </p>
          </div>
        </div>

        <p style={{ fontSize: 13.5, color: 'var(--ink-secondary)', margin: '0 0 12px' }}>
          本地仓库目标：
          {settings.obsidianVaultPath.trim() ? (
            <strong>
              <code>
                {settings.obsidianVaultPath.trim()}/{settings.obsidianSubfolder.trim() || 'X-Vocab'}
              </code>
            </strong>
          ) : (
            <span>未配置本机 Obsidian Vault 路径（可先点击设置填入路径，或直接导出 ZIP 解压入库）</span>
          )}
        </p>

        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13.5,
            color: 'var(--ink-secondary)',
            marginBottom: 16,
            cursor: 'pointer',
          }}
        >
          <input
            id="checkbox-panel-obsidian-sr"
            type="checkbox"
            checked={includeFlashcards}
            onChange={() => setFlashcardOverride(!includeFlashcards)}
          />
          <span>
            附带 Obsidian <strong>Spaced Repetition</strong> 插件多行闪卡格式（<code>#flashcards/x-vocab</code> + <code>?</code>）
          </span>
        </label>

        <div className="toolbar-row">
          <button
            id="btn-sync-obsidian"
            type="button"
            className="btn btn-primary"
            disabled={syncingObsidian || syncState.cards.length === 0}
            onClick={handleSyncObsidian}
          >
            <FileText size={15} />
            {syncingObsidian ? '正在写入 Vault...' : '一键写入 Obsidian Vault'}
          </button>

          <button
            id="btn-export-obsidian-zip"
            type="button"
            className="btn btn-sage"
            disabled={exportingObsidianZip || syncState.cards.length === 0}
            onClick={handleExportObsidianZip}
          >
            <Download size={15} />
            {exportingObsidianZip
              ? '正在打包...'
              : backendOnline
                ? '导出 Markdown (.zip)'
                : '离线导出 Markdown (.md)'}
          </button>

          <button type="button" className="btn" onClick={onOpenSettings}>
            <Settings size={14} />
            {settings.obsidianVaultPath.trim() ? '修改 Vault 路径' : '前往设置 Vault 路径'}
          </button>
        </div>
      </div>

      {/* Wordbook Management Table */}
      <div className="panel-card">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">词库管理明细（{filteredCards.length} 条）</h2>
            <p className="panel-subtitle">可按状态筛选或搜索特定单词，随时标为已熟知或清理词卡。</p>
          </div>
          <div className="toolbar-row">
            <div style={{ position: 'relative', minWidth: 210 }}>
              <Search
                size={14}
                style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-muted)' }}
              />
              <input
                id="input-search-vocab"
                className="input"
                style={{ paddingLeft: 30 }}
                placeholder="搜索单词、中文释义或博主..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select
              id="select-stage-filter"
              className="select"
              style={{ width: 'auto' }}
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value as 'all' | 'new' | 'learning' | 'mastered')}
            >
              <option value="all">全部状态</option>
              <option value="new">新词</option>
              <option value="learning">记忆中</option>
              <option value="mastered">已巩固</option>
            </select>
          </div>
        </div>

        {filteredCards.length === 0 ? (
          <p style={{ color: 'var(--ink-muted)', fontSize: 14, margin: '8px 0 0' }}>
            {syncState.cards.length === 0 ? '暂无词卡记录。' : '没有匹配的词卡。'}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="vocab-table">
              <thead>
                <tr>
                  <th>单词 / 短语</th>
                  <th>分类</th>
                  <th>语境中文释义</th>
                  <th>记忆状态</th>
                  <th>下次复习</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredCards.map((card) => {
                  const stage = getCardStageLabel(card)
                  const wordKey = card.word.trim().toLowerCase()
                  const isSkipped =
                    syncState.known_words.some((w) => w.trim().toLowerCase() === wordKey) ||
                    syncState.ignored_words.some((w) => w.trim().toLowerCase() === wordKey)
                  const dueDate = new Date(card.fsrs.due)
                  const dueLabel = isSkipped
                    ? '已暂停'
                    : card.fsrs.state === 0
                      ? '待首学'
                      : dueDate.getTime() <= now.getTime()
                        ? '已到期'
                        : `${formatIntervalZh(dueDate, now)}后`

                  return (
                    <tr key={card.id} style={isSkipped ? { opacity: 0.68 } : undefined}>
                      <td>
                        <div className="table-word">{card.word}</div>
                        <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                          {card.ipa} {card.pos}
                          {card.author_handle ? ` · @${card.author_handle}` : ''}
                        </div>
                      </td>
                      <td>
                        <span className={`tag ${card.category}`}>{categoryLabelZh(card.category)}</span>
                      </td>
                      <td style={{ maxWidth: 300 }}>
                        <div>{card.meaning_zh}</div>
                      </td>
                      <td>
                        {isSkipped ? (
                          <span className="tag">已熟知/屏蔽</span>
                        ) : (
                          <span className={`tag ${stage.tone === 'mastered' ? 'mastered' : ''}`}>
                            {stage.label} ({card.fsrs.reps}次)
                          </span>
                        )}
                      </td>
                      <td className="tabular">{dueLabel}</td>
                      <td>
                        <div className="toolbar-row" style={{ gap: 4 }}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => speakEnglishText(card.word, settings.ttsAccent)}
                            title="发音"
                          >
                            <Volume2 size={14} />
                          </button>
                          {isSkipped ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => onRestoreKnownOrIgnored(card.word)}
                              title="恢复进入复习队列"
                            >
                              恢复
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => onMarkKnown(card)}
                              title="移入已熟知词库"
                            >
                              已熟知
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => onDeleteCard(card.id)}
                            title="删除词卡"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {combinedSkipped.length > 0 && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-hairline)' }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowSkipped((v) => !v)}
            >
              {showSkipped ? '收起' : '查看'}已过滤的熟词 / 屏蔽词 ({combinedSkipped.length})
            </button>

            {showSkipped && (
              <div className="chip-row" style={{ marginTop: 10, marginBottom: 0 }}>
                {combinedSkipped.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className="chip"
                    title="点击恢复到词选池（移出已熟知/屏蔽名单）"
                    onClick={() => onRestoreKnownOrIgnored(w)}
                  >
                    {w} ×
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
