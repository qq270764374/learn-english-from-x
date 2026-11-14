import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StudyView } from '../components/StudyView'
import { buildOfflineDemoCards } from '../data/starterCreators'
import { buildDueQueue } from '../services/srs'
import { createEmptySyncState, DEFAULT_SETTINGS } from '../types/vocab'
import { resetSpeechSynthesisStateForTests, speakEnglishText } from '../utils/textHelpers'

class MockSpeechSynthesisUtterance {
  text: string
  lang = ''
  rate = 1
  voice: SpeechSynthesisVoice | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(text: string) {
    this.text = text
  }
}

function installSpeechMock(options?: { voices?: SpeechSynthesisVoice[]; speaking?: boolean }) {
  const speak = vi.fn()
  const cancel = vi.fn()
  const resume = vi.fn()
  const addEventListener = vi.fn()
  const removeEventListener = vi.fn()
  const voices = options?.voices ?? [
    { lang: 'en-US', localService: false, name: 'Remote US' } as SpeechSynthesisVoice,
    { lang: 'en-US', localService: true, name: 'Local US' } as SpeechSynthesisVoice,
  ]
  const synth = {
    speaking: options?.speaking ?? false,
    pending: false,
    paused: false,
    speak,
    cancel,
    resume,
    getVoices: vi.fn(() => voices),
    addEventListener,
    removeEventListener,
  }
  vi.stubGlobal('SpeechSynthesisUtterance', MockSpeechSynthesisUtterance)
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: synth,
  })
  return { synth, speak, cancel }
}

describe('StudyView component', () => {
  afterEach(() => {
    cleanup()
    resetSpeechSynthesisStateForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

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

  it('supports R (including IME KeyR) and S shortcuts for word and sentence pronunciation', () => {
    vi.useFakeTimers()
    const { speak, cancel } = installSpeechMock()
    const cards = buildOfflineDemoCards(new Date('2026-11-12T10:00:00Z'))
    const state = createEmptySyncState()
    state.cards = [cards[0]]
    const dueQueue = buildDueQueue(state, { dailyNewLimit: 15 })

    render(
      <StudyView
        dueQueue={dueQueue}
        totalCardsCount={1}
        settings={{ ...DEFAULT_SETTINGS, showContextOnFront: false }}
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

    // Ctrl+R should not intercept browser reload
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR', ctrlKey: true })
    vi.advanceTimersByTime(200)
    expect(speak).not.toHaveBeenCalled()

    // S should not speak hidden sentence before flipping
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' })
    vi.advanceTimersByTime(200)
    expect(speak).not.toHaveBeenCalled()

    // Pressing R (or Chinese IME Process + KeyR) pronounces word without idle cancel()
    fireEvent.keyDown(window, { key: 'Process', code: 'KeyR' })
    vi.advanceTimersByTime(120)
    expect(cancel).not.toHaveBeenCalled()
    expect(speak).toHaveBeenCalledTimes(1)
    expect((speak.mock.calls[0][0] as MockSpeechSynthesisUtterance).text).toBe(cards[0].word)

    // Flip card, then press S to pronounce full sentence
    fireEvent.click(screen.getByText(/查看释义与语境记忆/))
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' })
    expect(speak).toHaveBeenCalledTimes(2)
    expect((speak.mock.calls[1][0] as MockSpeechSynthesisUtterance).text).toBe(cards[0].sample_tweet)
  })

  it('avoids idle cancel on cold start, prefers local matching voice, and defers after cancel when interrupting', () => {
    vi.useFakeTimers()
    const { synth, speak, cancel } = installSpeechMock()

    expect(speakEnglishText('subtle', 'en-US')).toBe(true)
    expect(cancel).not.toHaveBeenCalled()
    expect(speak).not.toHaveBeenCalled()

    vi.advanceTimersByTime(110)
    expect(speak).toHaveBeenCalledTimes(1)
    const firstUtterance = speak.mock.calls[0][0] as MockSpeechSynthesisUtterance
    expect(firstUtterance.text).toBe('subtle')
    expect(firstUtterance.voice?.name).toBe('Local US')

    // Subsequent idle speak fires immediately
    expect(speakEnglishText('nuance', 'en-US')).toBe(true)
    expect(cancel).not.toHaveBeenCalled()
    expect(speak).toHaveBeenCalledTimes(2)

    // Interrupting active playback calls cancel and waits briefly before speaking
    synth.speaking = true
    expect(speakEnglishText('benchmark', 'en-US')).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(speak).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(80)
    expect(speak).toHaveBeenCalledTimes(3)
    expect((speak.mock.calls[2][0] as MockSpeechSynthesisUtterance).text).toBe('benchmark')
  })
})
