import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IngestConsole } from '../components/IngestConsole'
import { createEmptySyncState, DEFAULT_SETTINGS, type TweetItem } from '../types/vocab'

describe('IngestConsole expanded vocabulary filter tiers', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('forwards extended tiers and custom Zipf/cutoff settings to /api/extract and /api/enrich', async () => {
    const sampleTweet: TweetItem = {
      id: 'tw-adv-1',
      url: 'https://x.com/researcher/status/1',
      author_handle: '@researcher',
      author_name: 'Researcher',
      text: 'This ephemeral paradigm shift exposes subtle diminishing returns across agentic workflows.',
      created_at: '2026-11-14T10:00:00Z',
      source_page: 'home',
    }

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/extract') {
        return new Response(
          JSON.stringify({
            total_tweets_analyzed: 1,
            candidates: [
              {
                lemma: 'ephemeral',
                surface_forms: ['ephemeral'],
                pos: 'adj',
                is_phrase: false,
                is_slang_seed: false,
                slang_hint: '',
                corpus_count: 1,
                zipf_score: 2.6,
                sweet_spot_score: 5.2,
                sample_tweets: [
                  {
                    tweet_id: 'tw-adv-1',
                    author_handle: '@researcher',
                    url: 'https://x.com/researcher/status/1',
                    text: sampleTweet.text,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url === '/api/enrich') {
        return new Response(
          JSON.stringify({
            cards: [
              {
                id: 'card-ephemeral',
                word: 'ephemeral',
                ipa: '/ɪˈfemərəl/',
                pos: 'adj.',
                category: 'standard',
                cefr_level: 'C2',
                meaning_zh: '短暂的，转瞬即逝的',
                memory_tip_zh: '希腊词根 ephemeros 意为“仅存一日的”',
                sample_tweet: sampleTweet.text,
                sample_tweet_zh: '这种短暂的范式转移暴露了智能体工作流中隐含的边际收益递减。',
                author_handle: '@researcher',
                tweet_url: sampleTweet.url,
                fsrs: {
                  due: '2026-11-14T10:00:00Z',
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
                created_at: '2026-11-14T10:00:00Z',
                updated_at: '2026-11-14T10:00:00Z',
              },
            ],
            skipped_ignored: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('Not Found', { status: 404 })
    })

    const onAddCards = vi.fn()
    render(
      <IngestConsole
        tweets={[sampleTweet]}
        syncState={createEmptySyncState()}
        settings={DEFAULT_SETTINGS}
        creators={[]}
        backendOnline={true}
        onUpdateTweets={vi.fn()}
        onAddCards={onAddCards}
        onMarkKnownWord={vi.fn()}
        onGoToStudy={vi.fn()}
        onOpenSettings={vi.fn()}
        onNotify={vi.fn()}
      />,
    )

    const tierSelect = screen.getByLabelText('过滤基础词库：') as HTMLSelectElement
    expect(Array.from(tierSelect.options).map((o) => o.value)).toEqual([
      'strict_1200',
      'basic_2000',
      'cet4_3500',
      'cet6_5500',
      'ielts_8000',
      'advanced_12000',
      'custom',
    ])

    fireEvent.change(tierSelect, { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('屏蔽前 N 高频词'), { target: { value: '10000' } })
    fireEvent.change(screen.getByLabelText('Zipf 下限（更冷门）'), { target: { value: '1.5' } })
    fireEvent.change(screen.getByLabelText('Zipf 上限（更常见）'), { target: { value: '3.9' } })
    fireEvent.click(screen.getByRole('button', { name: /提取高性价比生词/ }))

    await waitFor(() => {
      expect(screen.getByText('ephemeral')).toBeInTheDocument()
    })

    const extractCall = fetchMock.mock.calls.find((call) => String(call[0]) === '/api/extract')
    expect(extractCall).toBeTruthy()
    const extractBody = JSON.parse(String(extractCall?.[1]?.body))
    expect(extractBody).toMatchObject({
      filter_tier: 'custom',
      custom_vocab_limit: 10000,
      custom_zipf_min: 1.5,
      custom_zipf_max: 3.9,
    })

    fireEvent.click(screen.getByRole('button', { name: /生成语境词卡/ }))

    await waitFor(() => {
      expect(onAddCards).toHaveBeenCalledTimes(1)
    })

    const enrichCall = fetchMock.mock.calls.find((call) => String(call[0]) === '/api/enrich')
    expect(enrichCall).toBeTruthy()
    const enrichBody = JSON.parse(String(enrichCall?.[1]?.body))
    expect(enrichBody).toMatchObject({
      filter_tier: 'custom',
      custom_vocab_limit: 10000,
    })
  })
})
