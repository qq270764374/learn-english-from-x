import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StatsAndExport } from '../components/StatsAndExport'
import { buildOfflineDemoCards } from '../data/starterCreators'
import { createEmptySyncState, DEFAULT_SETTINGS } from '../types/vocab'
import { buildOfflineObsidianMarkdown } from '../utils/textHelpers'

describe('Obsidian integration helpers & export controls', () => {
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
})
