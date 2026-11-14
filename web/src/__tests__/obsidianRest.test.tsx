import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildObsidianAudioUrl,
  launchObsidianSpacedRepetition,
  pullObsidianSrProgress,
  renderObsidianCardMarkdown,
  syncObsidianRest,
  testObsidianRestConnection,
  USER_NOTES_MARKER,
} from '../services/obsidianRest'
import { DEFAULT_SETTINGS, type VocabCard } from '../types/vocab'

function makeSampleCard(overrides?: Partial<VocabCard>): VocabCard {
  return {
    id: 'card-1',
    word: 'nuance',
    ipa: '/ˈnjuːɑːns/',
    pos: 'n.',
    category: 'standard',
    cefr_level: 'C1',
    meaning_zh: '微妙的差别；细微之处',
    memory_tip_zh: '细微区别在于态度语气',
    sample_tweet: 'There is a subtle nuance in how native speakers phrase this.',
    sample_tweet_zh: '母语者在表达这句话时带有微妙的语感差别。',
    author_handle: '@paulg',
    tweet_url: 'https://x.com/paulg/status/123',
    fsrs: {
      due: '2026-04-12T00:00:00Z',
      stability: 3.5,
      difficulty: 5.0,
      elapsed_days: 1,
      scheduled_days: 4,
      learning_steps: 0,
      reps: 2,
      lapses: 0,
      state: 2,
      last_review: '2026-04-08T00:00:00Z',
    },
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-08T00:00:00Z',
    ...overrides,
  }
}

describe('obsidianRest service', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('probes Local REST API directly from browser and detects bad API keys', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'OK',
            authenticated: true,
            versions: { obsidian: '1.8.4', self: '3.1.0' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'OK',
            authenticated: false,
            versions: { obsidian: '1.8.4', self: '3.1.0' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    const okRes = await testObsidianRestConnection({
      apiUrl: 'http://127.0.0.1:27123/',
      apiKey: 'good-key',
      backendOnline: false,
    })
    expect(okRes.ok).toBe(true)
    expect(okRes.authenticated).toBe(true)
    expect(okRes.via).toBe('browser')
    expect(okRes.plugin_version).toBe('3.1.0')

    const badRes = await testObsidianRestConnection({
      apiUrl: 'http://127.0.0.1:27123',
      apiKey: 'wrong-key',
      backendOnline: false,
    })
    expect(badRes.ok).toBe(false)
    expect(badRes.authenticated).toBe(false)
    expect(badRes.message).toContain('API Key')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to Python backend test when HTTPS self-signed cert blocks browser fetch', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            url: DEFAULT_SETTINGS.obsidianRestUrl,
            status_code: 200,
            authenticated: true,
            latency_ms: 19,
            plugin_version: '3.1.0',
            obsidian_version: '1.8.4',
            message: '连通成功',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    const res = await testObsidianRestConnection({
      apiUrl: 'https://127.0.0.1:27124',
      apiKey: 'secret-token',
      backendOnline: true,
    })
    expect(res.ok).toBe(true)
    expect(res.via).toBe('backend')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/export/obsidian-rest-test')
  })

  it('syncs cards via GET+PUT and preserves Spaced Repetition comments and user notes', async () => {
    const store = new Map<string, string>()
    store.set(
      'Study/X-Vocab/nuance.md',
      [
        '# nuance',
        '## 闪卡复习 #flashcards/x-vocab',
        '**nuance**',
        '?',
        '**旧释义**',
        '<!--SR:!2026-04-20,7,250-->',
        '',
        USER_NOTES_MARKER,
        '',
        '## 我的个人笔记',
        '',
        '- 自定义例句：He captured every nuance of the policy.',
      ].join('\n'),
    )

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const prefix = 'http://127.0.0.1:27123/vault/'
      if (!url.startsWith(prefix)) {
        return new Response('Not Found', { status: 404 })
      }
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.Authorization !== 'Bearer my-obs-key') {
        return new Response('Unauthorized', { status: 401 })
      }

      const relPath = decodeURIComponent(url.slice(prefix.length))
      if ((init?.method ?? 'GET') === 'GET') {
        const existing = store.get(relPath)
        return existing !== undefined
          ? new Response(existing, { status: 200 })
          : new Response('Not Found', { status: 404 })
      }
      if (init?.method === 'PUT') {
        store.set(relPath, String(init.body ?? ''))
        return new Response(null, { status: 204 })
      }
      return new Response('Method Not Allowed', { status: 405 })
    })

    const cards = [
      makeSampleCard(),
      makeSampleCard({
        id: 'card-2',
        word: 'figure out',
        category: 'collocation',
        meaning_zh: '弄明白；想出办法',
        sample_tweet: 'We figured out the bottleneck quickly.',
      }),
    ]

    const result = await syncObsidianRest({
      cards,
      apiUrl: 'http://127.0.0.1:27123/',
      apiKey: 'my-obs-key',
      subfolder: 'Study/X-Vocab',
      includeFlashcards: true,
      backendOnline: false,
    })

    expect(result.via).toBe('browser')
    expect(result.written_count).toBe(3)
    expect(result.files).toEqual(['_X-Vocab 词库总览.md', 'nuance.md', 'figure out.md'])

    const updatedNuance = store.get('Study/X-Vocab/nuance.md') ?? ''
    expect(updatedNuance).toContain('<!--SR:!2026-04-20,7,250-->')
    expect(updatedNuance).toContain('- 自定义例句：He captured every nuance of the policy.')
    expect(updatedNuance).toContain('==nuance==')

    const newPhrase = store.get('Study/X-Vocab/figure out.md') ?? ''
    expect(newPhrase).toContain('# figure out')
    expect(newPhrase).toContain('==figured out==')

    const indexMd = store.get('Study/X-Vocab/_X-Vocab 词库总览.md') ?? ''
    expect(indexMd).toContain('[[nuance]]')
    expect(indexMd).toContain('[[figure out]]')
  })

  it('renders bidirectional/inline SR formats, sub-deck tags, multiline blockquotes, and initial FSRS schedule', () => {
    const card = makeSampleCard({
      word: 'figure out',
      category: 'collocation',
      sample_tweet: 'Line one figure out.\n\nParagraph two stays inside blockquote.',
    })

    const bidir = renderObsidianCardMarkdown(card, {
      includeFlashcards: true,
      srDeckTag: '#flashcards/英语',
      srCardStyle: 'bidirectional',
      srSubdeckByCategory: true,
      seedSrFromFsrs: true,
    })
    expect(bidir).toContain('## 闪卡复习 #flashcards/英语/地道搭配')
    expect(bidir).toContain('> Line one ==figure out==.\n>\n> Paragraph two stays inside blockquote.')
    expect(bidir).toContain('\n??\n')
    expect(bidir).toContain('<!--SR:!2026-04-12,4,235!2026-04-12,4,235-->')

    const inline = renderObsidianCardMarkdown(card, {
      includeFlashcards: true,
      srDeckTag: 'flashcards/x-vocab',
      srCardStyle: 'inline',
      seedSrFromFsrs: true,
    })
    expect(inline).toContain('## 闪卡复习 #flashcards/x-vocab')
    expect(inline).toContain(':: **微妙的差别；细微之处**')
    expect(inline).toContain('<!--SR:!2026-04-12,4,235-->')
  })

  it('pulls Obsidian Spaced Repetition review comments back into web FSRS state and launches SR command', async () => {
    const newCard = makeSampleCard({
      fsrs: {
        due: '2026-11-10T00:00:00Z',
        stability: 0,
        difficulty: 0,
        elapsed_days: 0,
        scheduled_days: 0,
        learning_steps: 0,
        reps: 0,
        lapses: 0,
        state: 0,
        last_review: null,
      },
    })

    const launchedCommands: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === 'http://127.0.0.1:27123/vault/X-Vocab/') {
        return new Response(JSON.stringify({ files: ['nuance.md', '_X-Vocab 词库总览.md'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === 'http://127.0.0.1:27123/vault/X-Vocab/nuance.md') {
        return new Response(
          '---\nword: "nuance"\n---\n**nuance**\n?\n**细微差别**\n<!--SR:!2026-11-22,8,270-->',
          { status: 200 },
        )
      }
      if (url === 'http://127.0.0.1:27123/commands/') {
        return new Response(
          JSON.stringify({
            commands: [
              { id: 'obsidian-spaced-repetition:cram-flashcards', name: 'Cram Flashcards' },
              { id: 'obsidian-spaced-repetition:review-flashcards', name: 'Review Flashcards' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.startsWith('http://127.0.0.1:27123/commands/') && init?.method === 'POST') {
        launchedCommands.push(decodeURIComponent(url))
        return new Response(null, { status: 204 })
      }
      return new Response('Not Found', { status: 404 })
    })

    const pullRes = await pullObsidianSrProgress({
      mode: 'rest_api',
      cards: [newCard],
      apiUrl: 'http://127.0.0.1:27123',
      apiKey: 'my-key',
      subfolder: 'X-Vocab',
      backendOnline: false,
    })
    expect(pullRes.scanned_notes).toBe(1)
    expect(pullRes.notes_with_sr).toBe(1)
    expect(pullRes.updated_count).toBe(1)
    expect(pullRes.updated_words).toEqual(['nuance'])
    expect(pullRes.updated_cards[0].fsrs.scheduled_days).toBe(8)
    expect(pullRes.updated_cards[0].fsrs.due).toBe('2026-11-22T09:00:00.000Z')
    expect(pullRes.updated_cards[0].fsrs.reps).toBe(1)

    const launchRes = await launchObsidianSpacedRepetition({
      apiUrl: 'http://127.0.0.1:27123',
      apiKey: 'my-key',
      backendOnline: false,
    })
    expect(launchRes.ok).toBe(true)
    expect(launchRes.command_id).toBe('obsidian-spaced-repetition:review-flashcards')
    expect(launchedCommands).toEqual([
      'http://127.0.0.1:27123/commands/obsidian-spaced-repetition:review-flashcards/',
    ])
  })

  it('embeds Option B <audio> tags with UK/US accent and disables autoplay on bidirectional ?? cards', async () => {
    expect(DEFAULT_SETTINGS.obsidianSrAudio).toBe(true)
    expect(DEFAULT_SETTINGS.obsidianSrAudioAutoplay).toBe(true)

    expect(buildObsidianAudioUrl('figure out', 'en-US')).toBe(
      'https://dict.youdao.com/dictvoice?audio=figure%20out&type=2',
    )
    expect(buildObsidianAudioUrl('figure out', 'en-GB')).toBe(
      'https://dict.youdao.com/dictvoice?audio=figure%20out&type=1',
    )

    const card = makeSampleCard({
      word: 'figure out',
      sample_tweet: 'We should figure out the root cause.',
    })

    const usMultiline = renderObsidianCardMarkdown(card, {
      includeFlashcards: true,
      srCardStyle: 'multiline',
      srIncludeAudio: true,
      srAudioAutoplay: true,
      ttsAccent: 'en-US',
    })
    const usUrl = 'https://dict.youdao.com/dictvoice?audio=figure%20out&type=2'
    expect(usMultiline).toContain(`<audio controls preload="none" src="${usUrl}"></audio>\n\n## 语境释义`)
    expect(usMultiline).toContain(
      `**figure out** /ˈnjuːɑːns/ n.\n<audio controls autoplay src="${usUrl}"></audio>\n> We should ==figure out== the root cause.`,
    )

    const gbBidir = renderObsidianCardMarkdown(card, {
      includeFlashcards: true,
      srCardStyle: 'bidirectional',
      srIncludeAudio: true,
      srAudioAutoplay: true,
      ttsAccent: 'en-GB',
    })
    const gbUrl = 'https://dict.youdao.com/dictvoice?audio=figure%20out&type=1'
    expect(gbBidir).toContain(`<audio controls preload="none" src="${gbUrl}"></audio>`)
    expect(gbBidir).not.toContain('autoplay')

    const inlineMd = renderObsidianCardMarkdown(card, {
      includeFlashcards: true,
      srCardStyle: 'inline',
      srIncludeAudio: true,
      srAudioAutoplay: true,
      ttsAccent: 'en-US',
    })
    expect(inlineMd).toContain(`<audio controls autoplay src="${usUrl}"></audio> :: **微妙的差别；细微之处**`)

    const putBodies: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response('Not Found', { status: 404 })
      putBodies.push(String(init?.body ?? ''))
      return new Response(null, { status: 204 })
    })

    await syncObsidianRest({
      cards: [card],
      apiUrl: 'http://127.0.0.1:27123',
      apiKey: 'my-key',
      subfolder: 'X-Vocab',
      includeFlashcards: true,
      srIncludeAudio: true,
      srAudioAutoplay: true,
      ttsAccent: 'en-GB',
      backendOnline: false,
    })

    const uploadedCard = putBodies.find((b) => b.includes('figure out')) ?? ''
    expect(uploadedCard).toContain(`<audio controls autoplay src="${gbUrl}"></audio>`)
  })
})
