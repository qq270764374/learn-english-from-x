import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatsAndExport } from '../components/StatsAndExport'
import { buildOfflineDemoCards } from '../data/starterCreators'
import { createEmptySyncState, DEFAULT_SETTINGS } from '../types/vocab'
import { buildOfflineObsidianMarkdown } from '../utils/textHelpers'

describe('Obsidian integration helpers & export controls', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })
  it('renders offline Obsidian markdown with YAML frontmatter, wikilinks, highlights, and optional SR flashcards', () => {
    const cards = buildOfflineDemoCards(new Date('2026-11-12T10:00:00Z')).slice(0, 2)

    const withFlashcards = buildOfflineObsidianMarkdown(cards, true)
    expect(withFlashcards).toContain('title: "LearnEnglishFromX 词库汇总"')
    expect(withFlashcards).toContain('  - flashcards/x-vocab')
    expect(withFlashcards).toContain('[[@karpathy]]')
    expect(withFlashcards).toContain('==subtle==')
    expect(withFlashcards).toContain('### 闪卡 #flashcards/x-vocab')
    expect(withFlashcards).toContain('\n?\n')

    const notesOnly = buildOfflineObsidianMarkdown(cards, false)
    expect(notesOnly).toContain('[[@karpathy]]')
    expect(notesOnly).toContain('==subtle==')
    expect(notesOnly).not.toContain('flashcards/x-vocab')
    expect(notesOnly).not.toContain('\n?\n')

    const inlineWithAudio = buildOfflineObsidianMarkdown(cards, true, {
      srCardStyle: 'inline',
      srIncludeAudio: true,
      srAudioAutoplay: true,
      ttsAccent: 'en-GB',
    })
    const firstWord = encodeURIComponent(cards[0].word)
    expect(inlineWithAudio).toContain(
      `<audio controls preload="none" src="https://dict.youdao.com/dictvoice?audio=${firstWord}&type=1"></audio>`,
    )
    expect(inlineWithAudio).toContain(
      `<audio controls autoplay src="https://dict.youdao.com/dictvoice?audio=${firstWord}&type=1"></audio> :: `,
    )
  })

  it('prompts settings when clicking Obsidian Vault sync without configured vault path', () => {
    const cards = buildOfflineDemoCards(new Date('2026-11-12T10:00:00Z')).slice(0, 2)
    const state = createEmptySyncState()
    state.cards = cards

    const onOpenSettings = vi.fn()
    const onNotify = vi.fn()

    render(
      <StatsAndExport
        syncState={state}
        settings={{ ...DEFAULT_SETTINGS, obsidianVaultPath: '' }}
        backendOnline={true}
        syncingDrive={false}
        onSyncDrive={vi.fn().mockResolvedValue(undefined)}
        onOpenSettings={onOpenSettings}
        onDeleteCard={vi.fn()}
        onMarkKnown={vi.fn()}
        onRestoreKnownOrIgnored={vi.fn()}
        onImportStateBackup={vi.fn()}
        onNotify={onNotify}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /一键写入 Obsidian Vault/ }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('Obsidian Vault'), 'info')
  })

  it('pulls Spaced Repetition progress from Obsidian REST API and merges updated cards', async () => {
    const cards = buildOfflineDemoCards(new Date('2026-11-12T10:00:00Z')).slice(0, 1)
    cards[0] = {
      ...cards[0],
      fsrs: { ...cards[0].fsrs, reps: 0, last_review: null },
    }
    const state = createEmptySyncState()
    state.cards = cards

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/vault/X-Vocab/')) {
        return new Response(JSON.stringify({ files: [`${cards[0].word}.md`] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        `---\nword: "${cards[0].word}"\n---\n<!--SR:!2026-11-25,6,260-->`,
        { status: 200 },
      )
    })

    const onMergePulledCards = vi.fn()
    const onNotify = vi.fn()

    render(
      <StatsAndExport
        syncState={state}
        settings={{
          ...DEFAULT_SETTINGS,
          obsidianSyncMode: 'rest_api',
          obsidianRestUrl: 'http://127.0.0.1:27123',
          obsidianRestApiKey: 'obs-key',
        }}
        backendOnline={false}
        syncingDrive={false}
        onSyncDrive={vi.fn().mockResolvedValue(undefined)}
        onOpenSettings={vi.fn()}
        onDeleteCard={vi.fn()}
        onMarkKnown={vi.fn()}
        onRestoreKnownOrIgnored={vi.fn()}
        onImportStateBackup={vi.fn()}
        onMergePulledCards={onMergePulledCards}
        onNotify={onNotify}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /从 Obsidian 同步 SR 进度/ }))
    await waitFor(() => {
      expect(onMergePulledCards).toHaveBeenCalledTimes(1)
    })
    const updatedList = onMergePulledCards.mock.calls[0][0]
    expect(updatedList[0].fsrs.scheduled_days).toBe(6)
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('同步 1 张词卡'), 'success')
  })
})
