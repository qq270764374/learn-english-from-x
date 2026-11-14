import { describe, expect, it } from 'vitest'
import { buildOfflineDemoCards } from '../data/starterCreators'
import { mergeSyncStates } from '../services/googleDrive'
import { scheduleCardReview } from '../services/srs'
import { createEmptySyncState } from '../types/vocab'

describe('Google Drive Sync State Merge', () => {
  it('unions known/ignored/tweets, deduplicates review logs, and keeps newer updated card state', () => {
    const t0 = new Date('2026-11-12T08:00:00Z')
    const t1 = new Date('2026-11-12T12:00:00Z')
    const [cardA, cardB] = buildOfflineDemoCards(t0)

    const local = createEmptySyncState()
    local.cards = [cardA] // older updated_at (08:00)
    local.known_words = ['Basic']
    local.ignored_words = ['spam']
    local.processed_tweet_ids = ['tw-1']
    local.review_logs = [
      { card_id: cardA.id, word: cardA.word, rating: 3, reviewed_at: t0.toISOString(), state: 0 },
    ]

    const { updatedCard: newerCardA, logEntry: logA } = scheduleCardReview(cardA, 4, t1)
    const remote = createEmptySyncState()
    remote.cards = [newerCardA, cardB]
    remote.known_words = ['system', 'basic']
    remote.ignored_words = ['bot']
    remote.processed_tweet_ids = ['tw-1', 'tw-2']
    remote.review_logs = [
      { card_id: cardA.id, word: cardA.word, rating: 3, reviewed_at: t0.toISOString(), state: 0 },
      logA,
    ]

    const merged = mergeSyncStates(local, remote)

    expect(merged.cards).toHaveLength(2)
    const mergedA = merged.cards.find((c) => c.word === cardA.word)
    expect(mergedA?.fsrs.state).toBe(2) // Remote newer review wins
    expect(mergedA?.fsrs.reps).toBe(1)

    expect(merged.known_words).toEqual(['basic', 'system'])
    expect(merged.ignored_words).toEqual(['bot', 'spam'])
    expect(merged.processed_tweet_ids).toEqual(['tw-1', 'tw-2'])
    expect(merged.review_logs).toHaveLength(2) // Duplicate t0 log collapsed
  })
})
