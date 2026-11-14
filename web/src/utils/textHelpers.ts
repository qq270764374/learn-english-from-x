import { type ObsidianAudioAccent, renderObsidianAudioTag } from '../services/obsidianRest'

export interface TextSegment {
  text: string
  highlighted: boolean
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split tweet text into segments so occurrences of the target word/phrase
 * (including simple regular inflections like -s/-es/-ed/-ing) can be highlighted safely in React.
 */
export function splitHighlightSegments(tweetText: string, targetWord: string): TextSegment[] {
  const cleanWord = targetWord.trim()
  if (!tweetText || !cleanWord) {
    return [{ text: tweetText, highlighted: false }]
  }

  let patternSource: string
  if (cleanWord.includes(' ')) {
    const parts = cleanWord.split(/\s+/).map((part, idx) => {
      const escaped = escapeRegExp(part)
      return idx === 0 ? `${escaped}(?:s|es|ed|d|ing)?` : escaped
    })
    patternSource = `\\b${parts.join('\\s+(?:[a-zA-Z]+\\s+)?')}\\b`
  } else {
    const stem = cleanWord.endsWith('e') && cleanWord.length > 3 ? cleanWord.slice(0, -1) : cleanWord
    patternSource = `\\b(?:${escapeRegExp(cleanWord)}|${escapeRegExp(stem)}(?:e|es|s|ed|ing|er|ers|ly)?)\\b`
  }

  let regex: RegExp
  try {
    regex = new RegExp(`(${patternSource})`, 'gi')
  } catch {
    return [{ text: tweetText, highlighted: false }]
  }

  const rawParts = tweetText.split(regex)
  if (rawParts.length <= 1) {
    return [{ text: tweetText, highlighted: false }]
  }

  const segments: TextSegment[] = []
  for (let i = 0; i < rawParts.length; i += 1) {
    const chunk = rawParts[i]
    if (!chunk) continue
    segments.push({
      text: chunk,
      highlighted: i % 2 === 1,
    })
  }
  return segments
}

let speechWarmedUp = false
let speechPrimed = false
let pendingSpeakTimer: ReturnType<typeof setTimeout> | null = null
let cancelPendingVoiceWait: (() => void) | null = null
let activeUtterance: SpeechSynthesisUtterance | null = null
let activeSpeakRequestId = 0
let sharedAudioCtx: AudioContext | null = null

function pickEnglishVoice(
  voices: SpeechSynthesisVoice[],
  accent: 'en-US' | 'en-GB',
): SpeechSynthesisVoice | undefined {
  if (!Array.isArray(voices) || voices.length === 0) return undefined
  const target = accent.toLowerCase()
  const norm = (lang: string) => (lang || '').replace('_', '-').toLowerCase()
  return (
    voices.find((v) => norm(v.lang) === target && v.localService) ||
    voices.find((v) => norm(v.lang) === target) ||
    voices.find((v) => norm(v.lang).startsWith('en-') && v.localService) ||
    voices.find((v) => norm(v.lang).startsWith('en'))
  )
}

function wakeAudioOutput(): void {
  if (typeof window === 'undefined') return
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new AudioCtx()
    }
    const ctx = sharedAudioCtx
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {})
    }
    const sampleRate = ctx.sampleRate || 44100
    const frameCount = Math.max(1, Math.floor(sampleRate * 0.06))
    const buffer = ctx.createBuffer(1, frameCount, sampleRate)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = 0
    source.connect(gain)
    gain.connect(ctx.destination)
    source.onended = () => {
      if (ctx.state === 'running') {
        void ctx.suspend().catch(() => {})
      }
    }
    source.start(0)
  } catch {
    // Ignore when Web Audio is unavailable (e.g. test environments)
  }
}

export function warmUpSpeechSynthesis(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  try {
    const synth = window.speechSynthesis
    synth.getVoices()
    if (!speechWarmedUp) {
      speechWarmedUp = true
      if (typeof synth.addEventListener === 'function') {
        synth.addEventListener('voiceschanged', () => {
          synth.getVoices()
        })
      }
    }
  } catch {
    // Ignore environments without full SpeechSynthesis support
  }
}

export function resetSpeechSynthesisStateForTests(): void {
  speechWarmedUp = false
  speechPrimed = false
  activeUtterance = null
  activeSpeakRequestId = 0
  if (cancelPendingVoiceWait) {
    cancelPendingVoiceWait()
    cancelPendingVoiceWait = null
  }
  if (pendingSpeakTimer !== null) {
    clearTimeout(pendingSpeakTimer)
    pendingSpeakTimer = null
  }
}

export function speakEnglishText(text: string, accent: 'en-US' | 'en-GB' = 'en-US'): boolean {
  const cleanText = text.trim()
  if (
    !cleanText ||
    typeof window === 'undefined' ||
    !('speechSynthesis' in window) ||
    typeof SpeechSynthesisUtterance === 'undefined'
  ) {
    return false
  }
  try {
    warmUpSpeechSynthesis()
    const synth = window.speechSynthesis
    activeSpeakRequestId += 1
    const requestId = activeSpeakRequestId

    if (cancelPendingVoiceWait) {
      cancelPendingVoiceWait()
      cancelPendingVoiceWait = null
    }
    if (pendingSpeakTimer !== null) {
      clearTimeout(pendingSpeakTimer)
      pendingSpeakTimer = null
    }

    if (synth.paused) {
      synth.resume()
    }

    const wasBusy = Boolean(synth.speaking || synth.pending)
    if (wasBusy) {
      // Only cancel when actually speaking/pending; calling cancel() while idle
      // triggers a Chromium/Windows bug that clips the beginning of the utterance.
      synth.cancel()
    }

    const initialVoices = synth.getVoices()
    const needsVoiceWait = initialVoices.length === 0 && typeof synth.addEventListener === 'function'
    const needsColdPrime = !speechPrimed

    const dispatchSpeak = () => {
      if (requestId !== activeSpeakRequestId) return
      speechPrimed = true
      const utterance = new SpeechSynthesisUtterance(cleanText)
      utterance.lang = accent
      utterance.rate = 0.94
      const preferred = pickEnglishVoice(synth.getVoices(), accent)
      if (preferred) {
        utterance.voice = preferred
      }
      activeUtterance = utterance
      utterance.onend = () => {
        if (activeUtterance === utterance) {
          activeUtterance = null
        }
      }
      utterance.onerror = () => {
        if (activeUtterance === utterance) {
          activeUtterance = null
        }
      }
      synth.speak(utterance)
    }

    if (needsColdPrime) {
      wakeAudioOutput()
    }

    if (!wasBusy && !needsColdPrime && !needsVoiceWait) {
      dispatchSpeak()
      return true
    }

    const minColdDelay = needsColdPrime ? 100 : wasBusy ? 70 : 0
    const readyAt = Date.now() + minColdDelay

    if (needsVoiceWait) {
      let settled = false
      const detachListener = () => {
        if (typeof synth.removeEventListener === 'function') {
          synth.removeEventListener('voiceschanged', onVoicesChanged)
        }
      }
      const cleanupAndDispatch = () => {
        if (settled) return
        settled = true
        detachListener()
        if (cancelPendingVoiceWait === detachListener) {
          cancelPendingVoiceWait = null
        }
        if (pendingSpeakTimer !== null) {
          clearTimeout(pendingSpeakTimer)
          pendingSpeakTimer = null
        }
        const remaining = Math.max(0, readyAt - Date.now())
        if (remaining > 0) {
          pendingSpeakTimer = setTimeout(() => {
            pendingSpeakTimer = null
            dispatchSpeak()
          }, remaining)
        } else {
          dispatchSpeak()
        }
      }
      const onVoicesChanged = () => {
        if (synth.getVoices().length > 0) {
          cleanupAndDispatch()
        }
      }
      cancelPendingVoiceWait = detachListener
      synth.addEventListener('voiceschanged', onVoicesChanged)
      pendingSpeakTimer = setTimeout(cleanupAndDispatch, 180)
    } else {
      pendingSpeakTimer = setTimeout(() => {
        pendingSpeakTimer = null
        dispatchSpeak()
      }, minColdDelay)
    }

    return true
  } catch {
    return false
  }
}

export function formatRelativeTimeZh(iso: string | null | undefined): string {
  if (!iso) return '尚未同步'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '尚未同步'
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diffSec < 60) return '刚刚'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function categoryLabelZh(category: string): string {
  if (category === 'collocation') return '地道搭配'
  if (category === 'slang') return 'X 网感俚语'
  return '高频核心词'
}

function formatQuoteLines(text: string): string[] {
  const clean = text.trim()
  if (!clean) return []
  return clean.split(/\r?\n/).map((line) => (line.trim() ? `> ${line}` : '>'))
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeOfflineSrTag(tag: string | undefined): string {
  const raw = (tag ?? '').trim().replace(/\s+/g, '-').replace(/^#+/, '').replace(/^\/+|\/+$/g, '')
  return raw ? `#${raw}` : '#flashcards/x-vocab'
}

export function buildOfflineObsidianMarkdown(
  cards: Array<{
    word: string
    ipa: string
    pos: string
    category: string
    cefr_level: string
    meaning_zh: string
    memory_tip_zh: string
    sample_tweet: string
    sample_tweet_zh: string
    author_handle: string
    tweet_url: string
  }>,
  includeFlashcards: boolean,
  options?: {
    srDeckTag?: string
    srCardStyle?: 'multiline' | 'bidirectional' | 'inline'
    srSubdeckByCategory?: boolean
    srIncludeAudio?: boolean
    srAudioAutoplay?: boolean
    ttsAccent?: ObsidianAudioAccent
  },
): string {
  const baseTag = normalizeOfflineSrTag(options?.srDeckTag)
  const srStyle = options?.srCardStyle ?? 'multiline'
  const subdeckByCat = options?.srSubdeckByCategory ?? false
  const srIncludeAudio = options?.srIncludeAudio ?? false
  const srAudioAutoplay = options?.srAudioAutoplay ?? false
  const ttsAccent: ObsidianAudioAccent = options?.ttsAccent ?? 'en-US'
  const yamlTag = baseTag.replace(/^#/, '')

  const header = [
    '---',
    'title: "LearnEnglishFromX 词库汇总"',
    `total: ${cards.length}`,
    'tags:',
    '  - x-vocab',
    ...(includeFlashcards ? [`  - ${yamlTag}`] : []),
    '---',
    '',
    '# LearnEnglishFromX 词汇笔记',
    '',
  ]

  const sections = cards.map((card) => {
    const highlighted = splitHighlightSegments(card.sample_tweet, card.word)
      .map((s) => (s.highlighted ? `==${s.text}==` : s.text))
      .join('')
    const authorLink = card.author_handle ? `[[@${card.author_handle.replace(/^@/, '')}]]` : 'X'
    const subLabel = categoryLabelZh(card.category).replace(/\s+/g, '')
    const cardTag =
      subdeckByCat && !baseTag.endsWith(`/${subLabel}`) ? `${baseTag}/${subLabel}` : baseTag
    const noteAudioTag = srIncludeAudio
      ? renderObsidianAudioTag(card.word, { ttsAccent, autoplay: false })
      : ''
    const effectiveAutoplay = srAudioAutoplay && srStyle !== 'bidirectional'
    const flashcardAudioTag = srIncludeAudio
      ? renderObsidianAudioTag(card.word, { ttsAccent, autoplay: effectiveAutoplay })
      : ''

    const lines = [
      `## ${card.word}`,
      '',
      `- 音标/词性：\`${card.ipa || '-'}\` · \`${card.pos || '-'}\` · \`${card.cefr_level || 'B1'}\` · ${categoryLabelZh(card.category)}`,
      `- 语境释义：**${card.meaning_zh}**`,
      ...(card.memory_tip_zh ? [`- 记忆提示：${collapseSpaces(card.memory_tip_zh)}`] : []),
      `- 来源博主：${authorLink}${card.tweet_url ? ` · [查看原推](${card.tweet_url})` : ''}`,
      ...(noteAudioTag ? ['', noteAudioTag] : []),
      '',
      ...formatQuoteLines(highlighted),
      ...(card.sample_tweet_zh ? ['>', ...formatQuoteLines(card.sample_tweet_zh)] : []),
    ]

    if (includeFlashcards) {
      if (srStyle === 'inline') {
        const front = [card.word ? `**${card.word}**` : '', card.ipa, card.pos, flashcardAudioTag]
          .filter(Boolean)
          .join(' ')
        const back = [
          `**${collapseSpaces(card.meaning_zh)}**`,
          ...(card.memory_tip_zh ? [`记忆：${collapseSpaces(card.memory_tip_zh)}`] : []),
        ].join(' · ')
        lines.push('', `### 闪卡 ${cardTag}`, `${front} :: ${back}`)
      } else {
        const sep = srStyle === 'bidirectional' ? '??' : '?'
        lines.push(
          '',
          `### 闪卡 ${cardTag}`,
          `**${card.word}** ${card.ipa} ${card.pos}`.trim(),
          ...(flashcardAudioTag ? [flashcardAudioTag] : []),
          ...formatQuoteLines(highlighted),
          sep,
          `**${collapseSpaces(card.meaning_zh)}**`,
          ...(card.memory_tip_zh ? [`- 记忆：${collapseSpaces(card.memory_tip_zh)}`] : []),
        )
      }
    }
    lines.push('', '---', '')
    return lines.join('\n')
  })

  return [...header, ...sections].join('\n')
}

