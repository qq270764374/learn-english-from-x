import { createEmptyCard, fsrs, Rating, State, type Card, type Grade, type RecordLogItem } from 'ts-fsrs'
import type { FSRSStateModel, RatingGrade, ReviewLogEntry, SyncStateDocument, VocabCard } from '../types/vocab'

const scheduler = fsrs({
  request_retention: 0.9,
  maximum_interval: 3650,
  enable_fuzz: false,
  enable_short_term: true,
})

export interface ReviewPreview {
  rating: RatingGrade
  label: string
  hint: string
  intervalText: string
  due: string
}

export interface DueQueueResult {
  dueCards: VocabCard[]
  strictReviewCount: number
  newAvailableCount: number
  newInQueueCount: number
  learnAheadCount: number
  studiedNewToday: number
  reviewedTodayCount: number
}

function safeDate(value: string | null | undefined, fallback: Date): Date {
  if (!value) return fallback
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? fallback : d
}

export function createInitialFSRSState(now = new Date()): FSRSStateModel {
  const empty = createEmptyCard(now)
  return {
    due: empty.due.toISOString(),
    stability: empty.stability,
    difficulty: empty.difficulty,
    elapsed_days: 0,
    scheduled_days: empty.scheduled_days,
    learning_steps: empty.learning_steps,
    reps: empty.reps,
    lapses: empty.lapses,
    state: empty.state,
    last_review: null,
  }
}

export function fsrsStateToCard(state: FSRSStateModel, now = new Date()): Card {
  const numericState = state.state as State
  return {
    due: safeDate(state.due, now),
    stability: state.stability ?? 0,
    difficulty: state.difficulty ?? 0,
    scheduled_days: state.scheduled_days ?? 0,
    learning_steps: state.learning_steps ?? 0,
    reps: state.reps ?? 0,
    lapses: state.lapses ?? 0,
    state: numericState,
    last_review: state.last_review ? safeDate(state.last_review, now) : undefined,
  }
}

export function cardToFSRSState(card: Card, previousLastReview: string | null, reviewTime: Date): FSRSStateModel {
  let elapsedDays = 0
  if (previousLastReview) {
    const prev = safeDate(previousLastReview, reviewTime)
    elapsedDays = Math.max(0, Math.round((reviewTime.getTime() - prev.getTime()) / 86_400_000))
  }
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: elapsedDays,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: Number(card.state),
    last_review: card.last_review ? card.last_review.toISOString() : reviewTime.toISOString(),
  }
}

export function formatIntervalZh(due: Date, now: Date): string {
  const diffMs = Math.max(0, due.getTime() - now.getTime())
  const diffMinutes = diffMs / 60_000
  if (diffMinutes < 1.5) return '1 分钟'
  if (diffMinutes < 55) return `${Math.round(diffMinutes)} 分钟`
  const diffHours = diffMinutes / 60
  if (diffHours < 23.5) return `${Math.round(diffHours)} 小时`
  const diffDays = diffHours / 24
  if (diffDays < 30) return `${Math.max(1, Math.round(diffDays))} 天`
  if (diffDays < 365) return `${Math.max(1, Math.round(diffDays / 30))} 个月`
  const years = (diffDays / 365).toFixed(1).replace(/\.0$/, '')
  return `${years} 年`
}

const RATING_META: Record<RatingGrade, { label: string; hint: string }> = {
  1: { label: '忘记', hint: '完全没印象' },
  2: { label: '困难', hint: '想了一会儿' },
  3: { label: '记得', hint: '顺利想出释义' },
  4: { label: '很简单', hint: '脱口而出' },
}

export function previewReviewIntervals(card: VocabCard, now = new Date()): Record<RatingGrade, ReviewPreview> {
  const fsrsCard = fsrsStateToCard(card.fsrs, now)
  const recordLog = scheduler.repeat(fsrsCard, now)
  const ratings: RatingGrade[] = [1, 2, 3, 4]
  const result = {} as Record<RatingGrade, ReviewPreview>

  for (const r of ratings) {
    const item = recordLog[r as Grade] as RecordLogItem
    const meta = RATING_META[r]
    result[r] = {
      rating: r,
      label: meta.label,
      hint: meta.hint,
      intervalText: formatIntervalZh(item.card.due, now),
      due: item.card.due.toISOString(),
    }
  }
  return result
}

export function scheduleCardReview(
  card: VocabCard,
  rating: RatingGrade,
  now = new Date(),
): { updatedCard: VocabCard; logEntry: ReviewLogEntry } {
  const fsrsCard = fsrsStateToCard(card.fsrs, now)
  const gradeMap: Record<RatingGrade, Grade> = {
    1: Rating.Again,
    2: Rating.Hard,
    3: Rating.Good,
    4: Rating.Easy,
  }
  const result = scheduler.next(fsrsCard, now, gradeMap[rating])
  const nextFsrs = cardToFSRSState(result.card, card.fsrs.last_review, now)
  const isoNow = now.toISOString()

  const updatedCard: VocabCard = {
    ...card,
    fsrs: nextFsrs,
    updated_at: isoNow,
  }

  const logEntry: ReviewLogEntry = {
    card_id: card.id,
    word: card.word,
    rating,
    reviewed_at: isoNow,
    state: Number(result.log.state),
  }

  return { updatedCard, logEntry }
}

export function toLocalDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function buildDueQueue(
  state: SyncStateDocument,
  options: {
    dailyNewLimit: number
    extraNewAllowed?: number
    learnAheadMinutes?: number
    now?: Date
  },
): DueQueueResult {
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  const learnAheadMs = (options.learnAheadMinutes ?? 20) * 60_000
  const todayKey = toLocalDateKey(now)

  const skipSet = new Set<string>([
    ...state.known_words.map((w) => w.trim().toLowerCase()),
    ...state.ignored_words.map((w) => w.trim().toLowerCase()),
  ])

  const todayLogs = state.review_logs.filter((log) => {
    const parsed = new Date(log.reviewed_at)
    return !Number.isNaN(parsed.getTime()) && toLocalDateKey(parsed) === todayKey
  })

  const studiedNewIdsToday = new Set<string>()
  for (const log of todayLogs) {
    if (log.state === State.New) {
      studiedNewIdsToday.add(log.card_id)
    }
  }
  const studiedNewToday = studiedNewIdsToday.size

  const activeCards = state.cards.filter((c) => !skipSet.has(c.word.trim().toLowerCase()))

  const strictDue: VocabCard[] = []
  const learnAhead: VocabCard[] = []
  const newPool: VocabCard[] = []

  for (const card of activeCards) {
    const fsrsState = card.fsrs?.state ?? 0
    if (fsrsState === State.New) {
      newPool.push(card)
      continue
    }
    const dueMs = safeDate(card.fsrs?.due, now).getTime()
    if (dueMs <= nowMs) {
      strictDue.push(card)
    } else if (
      (fsrsState === State.Learning || fsrsState === State.Relearning) &&
      learnAheadMs > 0 &&
      dueMs <= nowMs + learnAheadMs
    ) {
      learnAhead.push(card)
    }
  }

  strictDue.sort((a, b) => safeDate(a.fsrs.due, now).getTime() - safeDate(b.fsrs.due, now).getTime())
  learnAhead.sort((a, b) => safeDate(a.fsrs.due, now).getTime() - safeDate(b.fsrs.due, now).getTime())
  newPool.sort((a, b) => safeDate(a.created_at, now).getTime() - safeDate(b.created_at, now).getTime())

  const totalNewBudget = Math.max(0, options.dailyNewLimit + (options.extraNewAllowed ?? 0) - studiedNewToday)
  const allowedNewCards = newPool.slice(0, totalNewBudget)

  const dueCards = [...strictDue, ...allowedNewCards, ...learnAhead]

  return {
    dueCards,
    strictReviewCount: strictDue.length,
    newAvailableCount: newPool.length,
    newInQueueCount: allowedNewCards.length,
    learnAheadCount: learnAhead.length,
    studiedNewToday,
    reviewedTodayCount: todayLogs.length,
  }
}

export function getCardStageLabel(card: VocabCard): { label: string; tone: 'new' | 'learning' | 'mastered' } {
  const st = card.fsrs?.state ?? 0
  if (st === State.New) return { label: '新词', tone: 'new' }
  if (st === State.Review && (card.fsrs?.scheduled_days ?? 0) >= 7) {
    return { label: '已巩固', tone: 'mastered' }
  }
  return { label: '记忆中', tone: 'learning' }
}
