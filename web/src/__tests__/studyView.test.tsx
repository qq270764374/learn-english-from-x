import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StudyView } from '../components/StudyView'
import { buildOfflineDemoCards } from '../data/starterCreators'
import { buildDueQueue } from '../services/srs'
import { createEmptySyncState, DEFAULT_SETTINGS } from '../types/vocab'

describe('StudyView component', () => {
  it('shows empty onboarding CTA when vocabulary deck is empty', () => {
    const emptyState = createEmptySyncState()
    const dueQueue = buildDueQueue(emptyState, { dailyNewLimit: 15 })

    render(
      <StudyView
        dueQueue={dueQueue}
        totalCardsCount={0}
        settings={DEFAULT_SETTINGS}
        isModalOpen={false}
        onRateCard={vi.fn()}
        onMarkKnown={vi.fn()}
        onIgnoreCard={vi.fn()}
        onLoadDemoCards={vi.fn().mockResolvedValue(undefined)}
        onAddExtraNew={vi.fn()}
        onToggleShowContext={vi.fn()}
        onGoToIngest={vi.fn()}
      />,
    )

    expect(screen.getByText('一键加载 7 张示例词卡')).toBeInTheDocument()
  })

  it('reveals meaning and rating buttons on flip and invokes onRateCard', () => {
    const cards = buildOfflineDemoCards(new Date('2026-11-12T10:00:00Z'))
    const state = createEmptySyncState()
    state.cards = [cards[0]]
    const dueQueue = buildDueQueue(state, { dailyNewLimit: 15 })
    const onRateCard = vi.fn()

    render(
      <StudyView
        dueQueue={dueQueue}
        totalCardsCount={1}
        settings={DEFAULT_SETTINGS}
        isModalOpen={false}
        onRateCard={onRateCard}
        onMarkKnown={vi.fn()}
        onIgnoreCard={vi.fn()}
        onLoadDemoCards={vi.fn().mockResolvedValue(undefined)}
        onAddExtraNew={vi.fn()}
        onToggleShowContext={vi.fn()}
        onGoToIngest={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'subtle' })).toBeInTheDocument()
    expect(screen.queryByText(cards[0].meaning_zh)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText(/查看释义与语境记忆/))
    expect(screen.getByText(cards[0].meaning_zh)).toBeInTheDocument()

    fireEvent.click(screen.getByText('记得'))
    expect(onRateCard).toHaveBeenCalledWith(cards[0], 3)
  })
})
