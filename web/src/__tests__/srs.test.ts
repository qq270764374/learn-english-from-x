import { describe, expect, it } from 'vitest'
import { buildOfflineDemoCards } from '../data/starterCreators'
import { buildDueQueue, previewReviewIntervals, scheduleCardReview } from '../services/srs'
import { createEmptySyncState } from '../types/vocab'

describe('FSRS Spaced Repetition Service', () => {
  it('generates 4 rating interval previews in Chinese for a new card', () => {
    const now = new Date('2026-11-12T10:00:00Z')
    const [card] = buildOfflineDemoCards(now)
    const previews = previewReviewIntervals(card, now)

    expect(previews[1].label).toBe('忘记')
    expect(previews[2].label).toBe('困难')
    expect(previews[3].label).toBe('记得')
    expect(previews[4].label).toBe('很简单')
    expect(previews[1].intervalText).toMatch(/分钟/)
    expect(previews[4].intervalText).toMatch(/天/)
  })

  it('advances card FSRS state on Good and Easy reviews and appends review log', () => {
    const now = new Date('2026-11-12T10:00:00Z')
    const [card] = buildOfflineDemoCards(now)

    const goodResult = scheduleCardReview(card, 3, now)
    expect(goodResult.updatedCard.fsrs.reps).toBe(1)
    expect(goodResult.updatedCard.fsrs.state).toBe(1) // Learning
    expect(goodResult.logEntry.rating).toBe(3)
    expect(goodResult.logEntry.state).toBe(0) // Pre-review state was New

    const easyResult = scheduleCardReview(card, 4, now)
    expect(easyResult.updatedCard.fsrs.state).toBe(2) // Review
    expect(easyResult.updatedCard.fsrs.scheduled_days).toBeGreaterThanOrEqual(1)
  })

  it('builds daily queue respecting dailyNewLimit, future due dates, and known/ignored lists', () => {
    const now = new Date('2026-11-12T10:00:00Z')
    const cards = buildOfflineDemoCards(now)
    // Schedule card[0] for 4 days in the future (not due)
    const { updatedCard: futureCard } = scheduleCardReview(cards[0], 4, now)
    // Mark card[1] as known and card[2] as ignored
    const state = createEmptySyncState()
    state.cards = [futureCard, ...cards.slice(1)]
    state.known_words = [cards[1].word]
    state.ignored_words = [cards[2].word]

    const queue = buildDueQueue(state, {
      dailyNewLimit: 2,
      learnAheadMinutes: 0,
      now,
    })

    // Out of 7 cards: card[0] is future review, card[1] known, card[2] ignored -> 4 new cards remain, capped at 2
    expect(queue.dueCards).toHaveLength(2)
    expect(queue.newAvailableCount).toBe(4)
    expect(queue.dueCards.map((c) => c.word)).not.toContain(cards[0].word)
    expect(queue.dueCards.map((c) => c.word)).not.toContain(cards[1].word)
    expect(queue.dueCards.map((c) => c.word)).not.toContain(cards[2].word)
  })
})
