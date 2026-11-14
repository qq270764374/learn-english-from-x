import type {
  ObsidianRestTestResponse,
  ObsidianSrCardStyle,
  ObsidianSrLaunchResult,
  ObsidianSrPullResult,
  VocabCard,
} from '../types/vocab'
import {
  launchObsidianSrViaBackend,
  pullObsidianSrViaBackend,
  syncObsidianRestViaBackend,
  testObsidianRestViaBackend,
  type ObsidianSyncResult,
} from './api'

export const USER_NOTES_MARKER = '<!-- lex-user-notes -->'
const SR_COMMENT_GLOBAL_RE = /^<!--SR:.*?-->$/gm
const SR_COMMENT_RE = /^<!--SR:.*?-->$/m
const SR_ENTRY_GLOBAL_RE = /!(\d{4}-\d{2}-\d{2}),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/g
const YAML_SR_DUE_RE = /^sr-due:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m
const YAML_SR_INTERVAL_RE = /^sr-interval:\s*(\d+)\s*$/m
const YAML_SR_EASE_RE = /^sr-ease:\s*(\d+)\s*$/m
const YAML_WORD_RE = /^word:\s*"(.+)"\s*$/m
const H1_WORD_RE = /^#\s+(.+?)\s*$/m
const INDEX_NOTE_FILENAME = '_X-Vocab 词库总览.md'

const STAGE_LABELS: Record<number, string> = {
  0: '新词',
  1: '学习中',
  2: '复习巩固',
  3: '重新记忆',
}

const CATEGORY_LABELS: Record<string, string> = {
  standard: '高频核心词',
  collocation: '地道搭配',
  slang: 'X 网感俚语',
}

const SR_SUBDECK_LABELS: Record<string, string> = {
  standard: '高频核心词',
  collocation: '地道搭配',
  slang: 'X网感俚语',
}

class ObsidianTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ObsidianTransportError'
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function yamlQuote(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').trim()
  return `"${escaped}"`
}

function datePart(iso?: string | null): string {
  if (!iso) return new Date().toISOString().slice(0, 10)
  return iso.length >= 10 ? iso.slice(0, 10) : iso
}

export function sanitizeNoteFilename(word: string): string {
  const cleaned = word
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
  return cleaned || 'vocab-card'
}

export function sanitizeRestSubfolder(subfolder: string): string {
  const parts = subfolder
    .trim()
    .split(/[/\\]+/)
    .map((seg) => sanitizeNoteFilename(seg).replace(/ /g, '-'))
    .filter((seg) => Boolean(seg) && seg !== '.' && seg !== '..')
  return parts.join('/') || 'X-Vocab'
}

export function normalizeObsidianRestUrl(apiUrl: string): string {
  const clean = apiUrl.trim().replace(/\/+$/, '')
  if (!clean) {
    throw new Error('请先填写 Obsidian Local REST API 地址（例如 http://127.0.0.1:27123 或 https://127.0.0.1:27124）。')
  }
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    throw new Error('Obsidian REST API 地址需以 http:// 或 https:// 开头。')
  }
  return clean
}

function encodeVaultPath(relPath: string): string {
  return relPath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export function extractPreservedNoteParts(existingMarkdown: string): {
  preservedSrComment: string
  preservedUserNotes: string
} {
  const srMatch = SR_COMMENT_RE.exec(existingMarkdown)
  const preservedSrComment = srMatch ? srMatch[0] : ''
  const markerIdx = existingMarkdown.indexOf(USER_NOTES_MARKER)
  const preservedUserNotes =
    markerIdx >= 0
      ? existingMarkdown.slice(markerIdx + USER_NOTES_MARKER.length).replace(/^[\r\n]+/, '')
      : ''
  return { preservedSrComment, preservedUserNotes }
}

export function assignCardFilenames(cards: VocabCard[]): Array<{ card: VocabCard; filename: string }> {
  const seen = new Set<string>()
  return cards.map((card) => {
    const base = sanitizeNoteFilename(card.word)
    let name = base
    let counter = 2
    while (seen.has(name.toLowerCase())) {
      name = `${base}-${counter}`
      counter += 1
    }
    seen.add(name.toLowerCase())
    return { card, filename: `${name}.md` }
  })
}

export function highlightMarkdownTweet(tweet: string, word: string): string {
  if (!tweet || !word.trim()) return tweet
  const cleanWord = word.trim()
  let patternSrc: string
  if (cleanWord.includes(' ')) {
    const parts = cleanWord.split(/\s+/).map((p) => escapeRegExp(p))
    parts[0] = `${parts[0]}(?:s|es|ed|d|ing)?`
    patternSrc = `\\b(${parts.join('\\s+(?:[a-zA-Z]+\\s+)?')})\\b`
  } else {
    const stem = cleanWord.endsWith('e') && cleanWord.length > 3 ? cleanWord.slice(0, -1) : cleanWord
    patternSrc = `\\b(${escapeRegExp(cleanWord)}|${escapeRegExp(stem)}(?:e|es|s|ed|ing|er|ers|ly)?)\\b`
  }
  try {
    const regex = new RegExp(patternSrc, 'gi')
    return tweet.replace(regex, '==$1==')
  } catch {
    return tweet
  }
}

function singleLine(text?: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function formatBlockquote(text?: string | null): string[] {
  const cleaned = (text ?? '').trim()
  if (!cleaned) return []
  return cleaned.split(/\r?\n/).map((line) => (line.trim() ? `> ${line}` : '>'))
}

export function normalizeSrDeckTag(tag?: string | null): string {
  const raw = (tag ?? '').trim().replace(/\s+/g, '-').replace(/^#+/, '').replace(/^\/+|\/+$/g, '')
  return raw ? `#${raw}` : '#flashcards/x-vocab'
}

export function resolveCardSrTag(
  card: VocabCard,
  options?: { srDeckTag?: string; srSubdeckByCategory?: boolean },
): string {
  const base = normalizeSrDeckTag(options?.srDeckTag)
  if (!options?.srSubdeckByCategory) return base
  const sub = SR_SUBDECK_LABELS[card.category] ?? card.category
  return base.endsWith(`/${sub}`) ? base : `${base}/${sub}`
}

export function formatFsrsAsSrComment(
  card: VocabCard,
  srCardStyle: ObsidianSrCardStyle = 'multiline',
): string {
  if (!card.fsrs || card.fsrs.reps <= 0) return ''
  const dueDate = datePart(card.fsrs.due)
  const interval = Math.max(1, Math.round(card.fsrs.scheduled_days || card.fsrs.stability || 1))
  const difficulty = Number(card.fsrs.difficulty ?? 5.0)
  const ease = Math.max(130, Math.min(300, Math.round(310 - difficulty * 15)))
  const entry = `!${dueDate},${interval},${ease}`
  return srCardStyle === 'bidirectional' ? `<!--SR:${entry}${entry}-->` : `<!--SR:${entry}-->`
}

export type ObsidianAudioAccent = 'en-US' | 'en-GB'

export function buildObsidianAudioUrl(word: string, ttsAccent: ObsidianAudioAccent = 'en-US'): string {
  const cleanWord = word.trim()
  if (!cleanWord) return ''
  const voiceType = ttsAccent === 'en-GB' ? '1' : '2'
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(cleanWord)}&type=${voiceType}`
}

export function renderObsidianAudioTag(
  word: string,
  options?: { ttsAccent?: ObsidianAudioAccent; autoplay?: boolean },
): string {
  const url = buildObsidianAudioUrl(word, options?.ttsAccent ?? 'en-US')
  if (!url) return ''
  const attrs = options?.autoplay ? 'controls autoplay' : 'controls preload="none"'
  return `<audio ${attrs} src="${url}"></audio>`
}

export function renderObsidianCardMarkdown(
  card: VocabCard,
  options?: {
    includeFlashcards?: boolean
    preservedSrComment?: string
    preservedUserNotes?: string
    srDeckTag?: string
    srCardStyle?: ObsidianSrCardStyle
    srSubdeckByCategory?: boolean
    seedSrFromFsrs?: boolean
    srIncludeAudio?: boolean
    srAudioAutoplay?: boolean
    ttsAccent?: ObsidianAudioAccent
  },
): string {
  const includeFlashcards = options?.includeFlashcards ?? true
  const preservedSrComment = options?.preservedSrComment ?? ''
  const preservedUserNotes = options?.preservedUserNotes ?? ''
  const srCardStyle: ObsidianSrCardStyle = options?.srCardStyle ?? 'multiline'
  const srIncludeAudio = options?.srIncludeAudio ?? false
  const srAudioAutoplay = options?.srAudioAutoplay ?? false
  const ttsAccent: ObsidianAudioAccent = options?.ttsAccent ?? 'en-US'

  const authorClean = card.author_handle.replace(/^@+/, '').trim()
  const authorLink = authorClean ? `[[@${authorClean}]]` : '[[X 推文]]'
  const stageLabel = STAGE_LABELS[card.fsrs?.state ?? 0] ?? '新词'
  const dueDate = datePart(card.fsrs?.due)
  const createdDate = datePart(card.created_at)
  const cefrTag = (card.cefr_level || 'B1').replace(/[^a-zA-Z0-9_-]/g, '') || 'B1'
  const highlightedTweet = highlightMarkdownTweet(card.sample_tweet, card.word)
  const catLabel = CATEGORY_LABELS[card.category] ?? '高频核心词'

  const lines: string[] = [
    '---',
    `word: ${yamlQuote(card.word)}`,
    `ipa: ${yamlQuote(card.ipa)}`,
    `pos: ${yamlQuote(card.pos)}`,
    `category: ${yamlQuote(card.category)}`,
    `cefr: ${yamlQuote(card.cefr_level)}`,
    `author: ${yamlQuote(authorLink)}`,
    `source_url: ${yamlQuote(card.tweet_url)}`,
    `fsrs_state: ${yamlQuote(stageLabel)}`,
    `reps: ${card.fsrs?.reps ?? 0}`,
    `next_review: ${yamlQuote(dueDate)}`,
    `created: ${yamlQuote(createdDate)}`,
    'tags:',
    '  - x-vocab',
    `  - x-vocab/${card.category}`,
    `  - cefr/${cefrTag}`,
    '---',
    '',
    `# ${card.word}`,
    '',
  ]

  const metaBits = [card.ipa, card.pos, catLabel, card.cefr_level].filter(Boolean)
  if (metaBits.length > 0) {
    lines.push(metaBits.map((bit) => `\`${bit}\``).join(' · '), '')
  }

  if (srIncludeAudio) {
    const noteAudioTag = renderObsidianAudioTag(card.word, { ttsAccent, autoplay: false })
    if (noteAudioTag) {
      lines.push(noteAudioTag, '')
    }
  }

  lines.push('## 语境释义', `**${card.meaning_zh}**`, '')

  if (card.memory_tip_zh) {
    lines.push('> [!tip] 记忆技巧', ...formatBlockquote(card.memory_tip_zh), '')
  }

  lines.push('## 原推文语境', ...formatBlockquote(highlightedTweet))
  if (card.sample_tweet_zh) lines.push('>', ...formatBlockquote(card.sample_tweet_zh))
  let sourceLine = `- 来源：${authorLink}`
  if (card.tweet_url) sourceLine += ` · [查看原推](${card.tweet_url})`
  lines.push(sourceLine, '')

  if (includeFlashcards) {
    const resolvedTag = resolveCardSrTag(card, {
      srDeckTag: options?.srDeckTag,
      srSubdeckByCategory: options?.srSubdeckByCategory,
    })
    const effectiveSr =
      preservedSrComment ||
      (options?.seedSrFromFsrs ? formatFsrsAsSrComment(card, srCardStyle) : '')
    const effectiveAutoplay = srAudioAutoplay && srCardStyle !== 'bidirectional'
    const flashcardAudioTag = srIncludeAudio
      ? renderObsidianAudioTag(card.word, { ttsAccent, autoplay: effectiveAutoplay })
      : ''

    lines.push(`## 闪卡复习 ${resolvedTag}`, '')
    if (srCardStyle === 'inline') {
      const front = [`**${card.word}**`, card.ipa, card.pos, flashcardAudioTag].filter(Boolean).join(' ')
      const backParts = [
        `**${singleLine(card.meaning_zh)}**`,
        ...(card.memory_tip_zh ? [`记忆：${singleLine(card.memory_tip_zh)}`] : []),
        ...(card.sample_tweet_zh ? [`译文：${singleLine(card.sample_tweet_zh)}`] : []),
      ]
      lines.push(`${front} :: ${backParts.join(' · ')}`)
    } else {
      const sep = srCardStyle === 'bidirectional' ? '??' : '?'
      lines.push(`**${card.word}** ${card.ipa} ${card.pos}`.trim())
      if (flashcardAudioTag) {
        lines.push(flashcardAudioTag)
      }
      lines.push(
        ...formatBlockquote(highlightedTweet),
        sep,
        `**${singleLine(card.meaning_zh)}**`,
      )
      if (card.memory_tip_zh) lines.push(`- 记忆：${singleLine(card.memory_tip_zh)}`)
      if (card.sample_tweet_zh) lines.push(`- 译文：${singleLine(card.sample_tweet_zh)}`)
    }
    if (effectiveSr) lines.push(effectiveSr)
    lines.push('')
  }

  lines.push(USER_NOTES_MARKER, '')
  if (preservedUserNotes.trim()) {
    lines.push(preservedUserNotes.trimEnd())
  } else {
    lines.push('## 我的个人笔记', '', '- 在这里补充联想、同义词或自己造的句子…')
  }
  lines.push('')
  return lines.join('\n')
}

export function renderObsidianIndexMarkdown(
  cards: VocabCard[],
  includeFlashcards = true,
  options?: { srDeckTag?: string; srCardStyle?: ObsidianSrCardStyle },
): string {
  const nowStr = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const cleanTag = normalizeSrDeckTag(options?.srDeckTag)
  const styleHintMap: Record<ObsidianSrCardStyle, string> = {
    multiline: '`?` 单向问答卡',
    bidirectional: '`??` 双向互测卡',
    inline: '`::` 单行速刷卡',
  }
  const styleHint = styleHintMap[options?.srCardStyle ?? 'multiline']

  const lines: string[] = [
    '---',
    'title: "LearnEnglishFromX 词库总览"',
    `total_cards: ${cards.length}`,
    `updated: ${yamlQuote(nowStr)}`,
    'tags:',
    '  - x-vocab',
    '  - moc',
    '---',
    '',
    '# LearnEnglishFromX 词库总览',
    '',
    `共收录 **${cards.length}** 个 X 推文实用词汇与表达（最近同步：${nowStr}）。`,
    '',
  ]

  if (includeFlashcards) {
    lines.push(
      '> [!info] 已开启 Spaced Repetition 闪卡兼容',
      `> 若您在 Obsidian 安装了 **Spaced Repetition** 插件，直接在插件侧边栏打开 \`${cleanTag}\`（当前模式：${styleHint}）即可刷卡片，系统会自动保留您的复习注释和个人笔记。`,
      '',
    )
  }

  const grouped: Record<string, VocabCard[]> = { standard: [], collocation: [], slang: [] }
  for (const card of cards) {
    ;(grouped[card.category] ??= []).push(card)
  }

  for (const catKey of ['standard', 'collocation', 'slang']) {
    const items = grouped[catKey] ?? []
    if (items.length === 0) continue
    lines.push(`## ${CATEGORY_LABELS[catKey] ?? catKey}（${items.length}）`, '')
    for (const card of items) {
      const noteName = sanitizeNoteFilename(card.word)
      const authorTag = card.author_handle ? `（[[@${card.author_handle.replace(/^@+/, '')}]]）` : ''
      lines.push(`- [[${noteName}]] — ${card.meaning_zh} ${authorTag}`.trimEnd())
    }
    lines.push('')
  }

  lines.push(
    '## Dataview 动态看板（可选插件）',
    '',
    '```dataview',
    'TABLE ipa as "音标", pos as "词性", cefr as "难度", author as "博主", next_review as "下次复习"',
    'FROM #x-vocab',
    'WHERE word',
    'SORT next_review ASC',
    '```',
    '',
  )
  return lines.join('\n')
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      credentials: 'omit',
      mode: 'cors',
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ObsidianTransportError(`连接 Obsidian Local REST API 超时（${url}）。`)
    }
    throw new ObsidianTransportError(err instanceof Error ? err.message : '浏览器网络请求失败')
  } finally {
    clearTimeout(timer)
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const current = cursor++
      results[current] = await worker(items[current], current)
    }
  })
  await Promise.all(workers)
  return results
}

function buildBrowserTransportErrorMessage(cleanUrl: string, backendOnline: boolean): string {
  if (cleanUrl.startsWith('https://')) {
    return backendOnline
      ? `无法连接 ${cleanUrl}：请确认 Obsidian 桌面端已打开且已启用 Local REST API 插件。若后端运行在 WSL2 中而 Obsidian 在 Windows 上，请在插件设置中开启「Enable Non-encrypted (HTTP) Server」并改用 http://127.0.0.1:27123。`
      : `浏览器直接访问 HTTPS（${cleanUrl}）被拦截：通常是因为 Obsidian 自签名证书尚未在浏览器受信任，或服务未启动。建议在 Obsidian Local REST API 插件设置中开启「Enable Non-encrypted (HTTP) Server」并改用 http://127.0.0.1:27123（或先在浏览器新标签页打开 ${cleanUrl} 信任证书）。`
  }
  return `无法连接到 ${cleanUrl}。请确认 Obsidian 桌面端已运行、已启用 Local REST API 插件，且在插件设置中开启了「Enable Non-encrypted (HTTP) Server」（默认端口 27123）。`
}

export async function testObsidianRestConnection(params: {
  apiUrl: string
  apiKey: string
  backendOnline?: boolean
}): Promise<ObsidianRestTestResponse> {
  let cleanUrl: string
  try {
    cleanUrl = normalizeObsidianRestUrl(params.apiUrl)
  } catch (err) {
    return {
      ok: false,
      url: params.apiUrl.trim(),
      authenticated: false,
      latency_ms: 0,
      plugin_version: '',
      obsidian_version: '',
      message: err instanceof Error ? err.message : 'REST API 地址格式无效',
      via: 'browser',
    }
  }

  const cleanKey = params.apiKey.trim()
  const started = Date.now()

  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (cleanKey) headers.Authorization = `Bearer ${cleanKey}`

    const resp = await fetchWithTimeout(`${cleanUrl}/`, { method: 'GET', headers }, 5000)
    const latencyMs = Math.max(0, Date.now() - started)

    let authenticated = false
    let pluginVersion = ''
    let obsidianVersion = ''
    try {
      const payload = (await resp.json()) as {
        authenticated?: boolean
        versions?: { self?: string; obsidian?: string }
      }
      authenticated = Boolean(payload?.authenticated)
      pluginVersion = payload?.versions?.self ?? ''
      obsidianVersion = payload?.versions?.obsidian ?? ''
    } catch {
      // Non-JSON error response
    }

    if (resp.status === 401 || resp.status === 403 || (resp.ok && !authenticated)) {
      return {
        ok: false,
        url: cleanUrl,
        status_code: resp.status,
        authenticated: false,
        latency_ms: latencyMs,
        plugin_version: pluginVersion,
        obsidian_version: obsidianVersion,
        message: '已连接到 Obsidian Local REST API 服务，但 Bearer API Key 未通过认证，请从插件设置中复制正确的 API Key。',
        via: 'browser',
      }
    }

    if (!resp.ok) {
      return {
        ok: false,
        url: cleanUrl,
        status_code: resp.status,
        authenticated,
        latency_ms: latencyMs,
        plugin_version: pluginVersion,
        obsidian_version: obsidianVersion,
        message: `Obsidian Local REST API 返回异常状态码 HTTP ${resp.status}。`,
        via: 'browser',
      }
    }

    const verNote = pluginVersion ? `（插件 v${pluginVersion}）` : ''
    return {
      ok: true,
      url: cleanUrl,
      status_code: resp.status,
      authenticated: true,
      latency_ms: latencyMs,
      plugin_version: pluginVersion,
      obsidian_version: obsidianVersion,
      message: `连通成功${verNote}，浏览器已直连 Obsidian Local REST API，可离线同步词卡。`,
      via: 'browser',
    }
  } catch {
    if (params.backendOnline) {
      try {
        const backendRes = await testObsidianRestViaBackend({ apiUrl: cleanUrl, apiKey: cleanKey })
        return { ...backendRes, via: 'backend' }
      } catch {
        // Fall through to helpful diagnostic message below
      }
    }

    return {
      ok: false,
      url: cleanUrl,
      authenticated: false,
      latency_ms: Math.max(0, Date.now() - started),
      plugin_version: '',
      obsidian_version: '',
      message: buildBrowserTransportErrorMessage(cleanUrl, Boolean(params.backendOnline)),
      via: 'browser',
    }
  }
}

export async function syncObsidianRest(params: {
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
  ttsAccent?: ObsidianAudioAccent
  backendOnline?: boolean
}): Promise<ObsidianSyncResult & { via: 'browser' | 'backend' }> {
  if (params.cards.length === 0) {
    throw new Error('当前词库为空，请先加载示例词卡或采集生成后再同步 Obsidian。')
  }

  const cleanUrl = normalizeObsidianRestUrl(params.apiUrl)
  const cleanKey = params.apiKey.trim()
  if (!cleanKey) {
    throw new Error('请先在设置中填写 Obsidian Local REST API Key。')
  }
  const cleanSub = sanitizeRestSubfolder(params.subfolder || 'X-Vocab')
  const authHeader = `Bearer ${cleanKey}`
  const srDeckTag = normalizeSrDeckTag(params.srDeckTag)
  const srCardStyle: ObsidianSrCardStyle = params.srCardStyle ?? 'multiline'
  const srSubdeckByCategory = params.srSubdeckByCategory ?? false
  const srSeedProgress = params.srSeedProgress ?? true
  const srIncludeAudio = params.srIncludeAudio ?? false
  const srAudioAutoplay = params.srAudioAutoplay ?? false
  const ttsAccent: ObsidianAudioAccent = params.ttsAccent ?? 'en-US'

  const putMarkdown = async (relPath: string, markdown: string) => {
    const endpoint = `${cleanUrl}/vault/${encodeVaultPath(relPath)}`
    const resp = await fetchWithTimeout(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'text/markdown; charset=utf-8',
      },
      body: markdown,
    })
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Obsidian Local REST API 认证失败（401/403），请核对插件中的 Bearer API Key。')
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      throw new Error(`写入 ${relPath} 失败（HTTP ${resp.status}）${detail ? `：${detail.slice(0, 120)}` : ''}`)
    }
  }

  const getExistingMarkdown = async (relPath: string): Promise<string | null> => {
    const endpoint = `${cleanUrl}/vault/${encodeVaultPath(relPath)}`
    const resp = await fetchWithTimeout(endpoint, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'text/markdown',
      },
    })
    if (resp.status === 200) return await resp.text()
    if (resp.status === 404) return null
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Obsidian Local REST API 认证失败（401/403），请核对插件中的 Bearer API Key。')
    }
    const detail = await resp.text().catch(() => '')
    throw new Error(`读取 ${relPath} 失败（HTTP ${resp.status}）${detail ? `：${detail.slice(0, 120)}` : ''}`)
  }

  try {
    await putMarkdown(
      `${cleanSub}/${INDEX_NOTE_FILENAME}`,
      renderObsidianIndexMarkdown(params.cards, params.includeFlashcards, {
        srDeckTag,
        srCardStyle,
      }),
    )

    const assigned = assignCardFilenames(params.cards)
    const cardFiles = await mapWithConcurrency(assigned, 6, async ({ card, filename }) => {
      const relPath = `${cleanSub}/${filename}`
      const existing = await getExistingMarkdown(relPath)
      const preserved =
        existing !== null
          ? extractPreservedNoteParts(existing)
          : { preservedSrComment: '', preservedUserNotes: '' }

      const newMarkdown = renderObsidianCardMarkdown(card, {
        includeFlashcards: params.includeFlashcards,
        preservedSrComment: preserved.preservedSrComment,
        preservedUserNotes: preserved.preservedUserNotes,
        srDeckTag,
        srCardStyle,
        srSubdeckByCategory,
        seedSrFromFsrs: srSeedProgress,
        srIncludeAudio,
        srAudioAutoplay,
        ttsAccent,
      })
      await putMarkdown(relPath, newMarkdown)
      return filename
    })

    const files = [INDEX_NOTE_FILENAME, ...cardFiles]
    return {
      target_dir: `${cleanUrl} (${cleanSub})`,
      written_count: files.length,
      files,
      via: 'browser',
    }
  } catch (err) {
    if (err instanceof ObsidianTransportError) {
      if (params.backendOnline) {
        const result = await syncObsidianRestViaBackend({
          cards: params.cards,
          apiUrl: cleanUrl,
          apiKey: cleanKey,
          subfolder: cleanSub,
          includeFlashcards: params.includeFlashcards,
          srDeckTag,
          srCardStyle,
          srSubdeckByCategory,
          srSeedProgress,
          srIncludeAudio,
          srAudioAutoplay,
          ttsAccent,
        })
        return { ...result, via: 'backend' }
      }
      throw new Error(buildBrowserTransportErrorMessage(cleanUrl, false))
    }
    throw err
  }
}

export interface ParsedObsidianSrMetadata {
  due: string
  interval: number
  ease: number
  word: string
}

export function parseObsidianSrMetadata(markdown: string): ParsedObsidianSrMetadata | null {
  const entries: Array<{ due: string; interval: number; ease: number }> = []

  SR_COMMENT_GLOBAL_RE.lastIndex = 0
  let commentMatch: RegExpExecArray | null
  while ((commentMatch = SR_COMMENT_GLOBAL_RE.exec(markdown)) !== null) {
    SR_ENTRY_GLOBAL_RE.lastIndex = 0
    let entryMatch: RegExpExecArray | null
    while ((entryMatch = SR_ENTRY_GLOBAL_RE.exec(commentMatch[0])) !== null) {
      entries.push({
        due: entryMatch[1],
        interval: Math.max(1, Math.round(Number(entryMatch[2]))),
        ease: Math.max(130, Math.round(Number(entryMatch[3]))),
      })
    }
  }

  if (entries.length === 0) {
    const yamlDue = YAML_SR_DUE_RE.exec(markdown)
    if (yamlDue) {
      const yamlInt = YAML_SR_INTERVAL_RE.exec(markdown)
      const yamlEase = YAML_SR_EASE_RE.exec(markdown)
      entries.push({
        due: yamlDue[1],
        interval: yamlInt ? Math.max(1, Number(yamlInt[1])) : 1,
        ease: yamlEase ? Math.max(130, Number(yamlEase[1])) : 250,
      })
    }
  }

  if (entries.length === 0) return null

  entries.sort((a, b) => a.due.localeCompare(b.due))
  const chosen = entries[0]

  let word = ''
  const wordMatch = YAML_WORD_RE.exec(markdown)
  if (wordMatch) {
    word = wordMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim()
  } else {
    const h1Match = H1_WORD_RE.exec(markdown)
    if (h1Match) word = h1Match[1].trim()
  }

  return {
    due: chosen.due,
    interval: chosen.interval,
    ease: chosen.ease,
    word,
  }
}

function subtractDaysIsoDate(dateStr: string, days: number): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!parts) return null
  const ms = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) - days * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

export function applyObsidianSrToCards(
  cards: VocabCard[],
  notes: Array<{ filename: string; markdown: string }>,
): Omit<ObsidianSrPullResult, 'via'> {
  const byWord = new Map<string, number>()
  const byStem = new Map<string, number>()
  cards.forEach((card, idx) => {
    const wKey = card.word.trim().toLowerCase()
    if (!byWord.has(wKey)) byWord.set(wKey, idx)
    const sKey = sanitizeNoteFilename(card.word).toLowerCase()
    if (!byStem.has(sKey)) byStem.set(sKey, idx)
  })

  const updatedMap = new Map<number, VocabCard>()
  let notesWithSr = 0
  const nowIso = new Date().toISOString()

  for (const { filename, markdown } of notes) {
    const parsed = parseObsidianSrMetadata(markdown)
    if (!parsed) continue
    notesWithSr += 1

    const wordKey = parsed.word.trim().toLowerCase()
    const baseName = filename.split('/').pop() ?? filename
    const stemKey = baseName.replace(/\.md$/i, '').trim().toLowerCase()
    const cardIdx = byWord.get(wordKey) ?? byStem.get(stemKey)
    if (cardIdx === undefined) continue

    const card = updatedMap.get(cardIdx) ?? cards[cardIdx]
    const inferredReview = subtractDaysIsoDate(parsed.due, parsed.interval)
    if (!inferredReview) continue

    const webLastReview = card.fsrs?.last_review ? datePart(card.fsrs.last_review) : ''
    const webDue = card.fsrs?.due ? datePart(card.fsrs.due) : ''
    if (
      (card.fsrs?.reps ?? 0) > 0 &&
      parsed.due === webDue &&
      parsed.interval === card.fsrs?.scheduled_days
    ) {
      continue
    }

    const shouldUpdate =
      (card.fsrs?.reps ?? 0) === 0 ||
      !webLastReview ||
      inferredReview > webLastReview ||
      (inferredReview === webLastReview && parsed.due > webDue)
    if (!shouldUpdate) continue

    const currentReps = card.fsrs?.reps ?? 0
    const isLapse = parsed.interval <= 1 && currentReps > 0
    const difficulty = Number(Math.min(10, Math.max(1, (310 - parsed.ease) / 15)).toFixed(2))
    updatedMap.set(cardIdx, {
      ...card,
      updated_at: nowIso,
      fsrs: {
        ...card.fsrs,
        due: `${parsed.due}T09:00:00.000Z`,
        scheduled_days: parsed.interval,
        stability: Math.max(0.5, parsed.interval),
        difficulty,
        reps: currentReps + 1,
        lapses: (card.fsrs?.lapses ?? 0) + (isLapse ? 1 : 0),
        state: isLapse ? 3 : 2,
        last_review: `${inferredReview}T09:00:00.000Z`,
      },
    })
  }

  const ordered = [...updatedMap.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
  return {
    scanned_notes: notes.length,
    notes_with_sr: notesWithSr,
    updated_count: ordered.length,
    updated_words: ordered.map((c) => c.word),
    updated_cards: ordered,
  }
}

export async function pullObsidianSrProgress(params: {
  mode: 'local_path' | 'rest_api'
  cards: VocabCard[]
  vaultPath?: string
  apiUrl?: string
  apiKey?: string
  subfolder: string
  backendOnline?: boolean
}): Promise<ObsidianSrPullResult> {
  if (params.cards.length === 0) {
    throw new Error('当前词库为空，无法匹配 Obsidian Spaced Repetition 复习进度。')
  }

  const cleanSub = params.subfolder.trim() || 'X-Vocab'

  if (params.mode === 'local_path') {
    const res = await pullObsidianSrViaBackend({
      mode: 'local_path',
      cards: params.cards,
      vaultPath: params.vaultPath,
      subfolder: cleanSub,
      applyToStore: true,
    })
    return { ...res, via: 'backend' }
  }

  const cleanUrl = normalizeObsidianRestUrl(params.apiUrl ?? '')
  const cleanKey = (params.apiKey ?? '').trim()
  if (!cleanKey) {
    throw new Error('请先在设置中填写 Obsidian Local REST API Key。')
  }
  const restSub = sanitizeRestSubfolder(cleanSub)
  const authHeader = `Bearer ${cleanKey}`

  try {
    const dirEndpoint = `${cleanUrl}/vault/${encodeVaultPath(restSub)}/`
    const dirResp = await fetchWithTimeout(dirEndpoint, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
    })
    if (dirResp.status === 401 || dirResp.status === 403) {
      throw new Error('Obsidian Local REST API 认证失败（401/403），请核对插件中的 Bearer API Key。')
    }
    if (dirResp.status === 404) {
      return {
        scanned_notes: 0,
        notes_with_sr: 0,
        updated_count: 0,
        updated_words: [],
        updated_cards: [],
        via: 'browser',
      }
    }

    let relPaths: string[] = []
    if (dirResp.ok) {
      try {
        const data = (await dirResp.json()) as { files?: unknown }
        if (Array.isArray(data?.files)) {
          relPaths = data.files
            .map((entry) => String(entry).replace(/^\/+/, ''))
            .filter((name) => name.endsWith('.md') && !name.endsWith(INDEX_NOTE_FILENAME))
            .map((name) => (name.startsWith(`${restSub}/`) ? name : `${restSub}/${name}`))
        }
      } catch {
        relPaths = []
      }
    }

    if (relPaths.length === 0) {
      relPaths = assignCardFilenames(params.cards).map(({ filename }) => `${restSub}/${filename}`)
    }

    const fetched = await mapWithConcurrency(relPaths, 6, async (relPath) => {
      const noteEndpoint = `${cleanUrl}/vault/${encodeVaultPath(relPath)}`
      const resp = await fetchWithTimeout(noteEndpoint, {
        method: 'GET',
        headers: { Authorization: authHeader, Accept: 'text/markdown' },
      })
      if (resp.status === 200) {
        return { filename: relPath, markdown: await resp.text() }
      }
      if (resp.status === 404) return null
      if (resp.status === 401 || resp.status === 403) {
        throw new Error('Obsidian Local REST API 认证失败（401/403），请核对插件中的 Bearer API Key。')
      }
      throw new Error(`读取 ${relPath} 失败（HTTP ${resp.status}）。`)
    })

    const notes = fetched.filter((item): item is { filename: string; markdown: string } => item !== null)
    const merged = applyObsidianSrToCards(params.cards, notes)
    return { ...merged, via: 'browser' }
  } catch (err) {
    if (err instanceof ObsidianTransportError) {
      if (params.backendOnline) {
        const res = await pullObsidianSrViaBackend({
          mode: 'rest_api',
          cards: params.cards,
          apiUrl: cleanUrl,
          apiKey: cleanKey,
          subfolder: restSub,
          applyToStore: true,
        })
        return { ...res, via: 'backend' }
      }
      throw new Error(buildBrowserTransportErrorMessage(cleanUrl, false))
    }
    throw err
  }
}

export async function launchObsidianSpacedRepetition(params: {
  apiUrl: string
  apiKey: string
  backendOnline?: boolean
}): Promise<ObsidianSrLaunchResult> {
  const cleanUrl = normalizeObsidianRestUrl(params.apiUrl)
  const cleanKey = params.apiKey.trim()
  if (!cleanKey) {
    throw new Error('请先在设置中填写 Obsidian Local REST API Key。')
  }
  const authHeader = `Bearer ${cleanKey}`

  try {
    const cmdResp = await fetchWithTimeout(`${cleanUrl}/commands/`, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
    })
    if (cmdResp.status === 401 || cmdResp.status === 403) {
      throw new Error('Obsidian Local REST API 认证失败（401/403），请核对插件 API Key。')
    }
    if (!cmdResp.ok) {
      throw new Error(`查询 Obsidian 命令列表失败（HTTP ${cmdResp.status}）。`)
    }

    const payload = (await cmdResp.json()) as { commands?: Array<{ id?: string; name?: string }> }
    const srCmds = (payload.commands ?? []).filter(
      (cmd) => typeof cmd?.id === 'string' && cmd.id.startsWith('obsidian-spaced-repetition:'),
    )
    if (srCmds.length === 0) {
      throw new Error(
        '未在 Obsidian 中检测到 Spaced Repetition 插件命令，请确认已在 Obsidian 安装并启用「Spaced Repetition」插件。',
      )
    }

    const scoreCommand = (cmd: { id?: string }): number => {
      const cid = (cmd.id ?? '').toLowerCase()
      if (cid.includes('review-flashcards') && !cid.includes('note')) return 0
      if (cid.includes('open-flashcard') || cid.includes('srs-open')) return 1
      if (cid.includes('flashcard') && !cid.includes('cram')) return 2
      return 3
    }

    const best = [...srCmds].sort((a, b) => scoreCommand(a) - scoreCommand(b))[0]
    const chosenId = best.id ?? ''
    const chosenName = best.name ?? ''

    const execResp = await fetchWithTimeout(
      `${cleanUrl}/commands/${encodeURIComponent(chosenId)}/`,
      { method: 'POST', headers: { Authorization: authHeader } },
    )
    if (execResp.status === 401 || execResp.status === 403) {
      throw new Error('Obsidian Local REST API 认证失败（401/403），请核对插件 API Key。')
    }
    if (!execResp.ok) {
      throw new Error(`唤醒命令 ${chosenId} 失败（HTTP ${execResp.status}）。`)
    }

    return {
      ok: true,
      command_id: chosenId,
      command_name: chosenName,
      message: `已在 Obsidian 中打开 Spaced Repetition 复习（${chosenName || chosenId}）。`,
      via: 'browser',
    }
  } catch (err) {
    if (err instanceof ObsidianTransportError) {
      if (params.backendOnline) {
        const res = await launchObsidianSrViaBackend({ apiUrl: cleanUrl, apiKey: cleanKey })
        return { ...res, via: 'backend' }
      }
      throw new Error(buildBrowserTransportErrorMessage(cleanUrl, false))
    }
    throw err
  }
}
