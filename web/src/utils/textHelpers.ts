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

export function speakEnglishText(text: string, accent: 'en-US' | 'en-GB' = 'en-US'): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    return false
  }
  try {
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = accent
    utterance.rate = 0.94
    const voices = window.speechSynthesis.getVoices()
    const preferred = voices.find((v) => v.lang === accent) || voices.find((v) => v.lang.startsWith('en'))
    if (preferred) {
      utterance.voice = preferred
    }
    window.speechSynthesis.speak(utterance)
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
): string {
  const header = [
    '---',
    'title: "LearnEnglishFromX 词库汇总"',
    `total: ${cards.length}`,
    'tags:',
    '  - x-vocab',
    ...(includeFlashcards ? ['  - flashcards/x-vocab'] : []),
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
    const lines = [
      `## ${card.word}`,
      '',
      `- 音标/词性：\`${card.ipa || '-'}\` · \`${card.pos || '-'}\` · \`${card.cefr_level || 'B1'}\` · ${categoryLabelZh(card.category)}`,
      `- 语境释义：**${card.meaning_zh}**`,
      ...(card.memory_tip_zh ? [`- 记忆提示：${card.memory_tip_zh}`] : []),
      `- 来源博主：${authorLink}${card.tweet_url ? ` · [查看原推](${card.tweet_url})` : ''}`,
      '',
      ...(highlighted ? [`> ${highlighted}`] : []),
      ...(card.sample_tweet_zh ? [`> \n> ${card.sample_tweet_zh}`] : []),
    ]

    if (includeFlashcards) {
      lines.push(
        '',
        '### 闪卡 #flashcards/x-vocab',
        `**${card.word}** ${card.ipa} ${card.pos}`.trim(),
        ...(highlighted ? [`> ${highlighted}`] : []),
        '?',
        `**${card.meaning_zh}**`,
        ...(card.memory_tip_zh ? [`- 记忆：${card.memory_tip_zh}`] : []),
      )
    }
    lines.push('', '---', '')
    return lines.join('\n')
  })

  return [...header, ...sections].join('\n')
}

