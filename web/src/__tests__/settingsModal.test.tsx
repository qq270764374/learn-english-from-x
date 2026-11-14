import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../components/SettingsModal'
import { DEFAULT_SETTINGS } from '../types/vocab'

describe('SettingsModal LLM connectivity test', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('probes /api/llm/test with local DeepSeek preset without requiring save first', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          provider: 'openai_compatible',
          model: 'deepseek-r1:7b',
          endpoint: 'http://localhost:11434/v1/chat/completions',
          latency_ms: 142,
          is_local: true,
          message: '连通成功（耗时 142 ms），本地模型 deepseek-r1:7b 响应正常。',
          reply_preview: 'OK',
          available_models: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const onBackendOnline = vi.fn()

    render(
      <SettingsModal
        open={true}
        settings={DEFAULT_SETTINGS}
        backendOnline={true}
        onBackendOnline={onBackendOnline}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '本地自建 DeepSeek (Ollama)' }))
    fireEvent.click(screen.getByRole('button', { name: /测试大模型连通性/ }))

    await waitFor(() => {
      expect(screen.getByText(/连通成功 · 142 ms/)).toBeInTheDocument()
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/llm/test')
    const sent = JSON.parse(String(init?.body))
    expect(sent.llm_config).toEqual({
      provider: 'openai_compatible',
      api_key: null,
      base_url: 'http://localhost:11434/v1',
      model: 'deepseek-r1:7b',
    })
    expect(onBackendOnline).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/本地直连免代理/)).toBeInTheDocument()
  })

  it('allows selecting an available model chip when remote reports model not found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          provider: 'openai_compatible',
          model: 'deepseek-r1:8b',
          endpoint: 'http://localhost:11434/v1/chat/completions',
          latency_ms: 28,
          is_local: true,
          message: '模型 "deepseek-r1:8b" 未找到（HTTP 404）',
          reply_preview: '',
          available_models: ['deepseek-r1:14b', 'qwen2.5:7b'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    render(
      <SettingsModal
        open={true}
        settings={{
          ...DEFAULT_SETTINGS,
          llmBaseUrl: 'http://localhost:11434/v1',
          llmModel: 'deepseek-r1:8b',
        }}
        backendOnline={true}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /测试大模型连通性/ }))

    await waitFor(() => {
      expect(screen.getByText(/连通失败 · 28 ms/)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'deepseek-r1:14b' }))
    expect(screen.getByLabelText('模型名称')).toHaveValue('deepseek-r1:14b')
    expect(screen.queryByText(/连通失败/)).not.toBeInTheDocument()
  })

  it('shows clear backend offline error when /api/llm/test is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    render(
      <SettingsModal
        open={true}
        settings={DEFAULT_SETTINGS}
        backendOnline={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /测试大模型连通性/ }))

    await waitFor(() => {
      expect(screen.getByText(/后端连接失败/)).toBeInTheDocument()
    })
    expect(screen.getByText(/无法连接本地 Python 后端/)).toBeInTheDocument()
  })

  it('switches to Obsidian Local REST API mode, tests connection, and saves config', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'OK',
          authenticated: true,
          versions: { obsidian: '1.8.4', self: '3.1.0' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const onSave = vi.fn()
    const onClose = vi.fn()

    render(
      <SettingsModal
        open={true}
        settings={DEFAULT_SETTINGS}
        backendOnline={false}
        onSave={onSave}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Local REST API 插件' }))
    fireEvent.click(screen.getByRole('button', { name: /HTTP 本地端口 \(27123/ }))
    fireEvent.change(screen.getByLabelText(/Obsidian REST API Key/), {
      target: { value: 'obs-secret-key' },
    })
    fireEvent.change(screen.getByLabelText('Spaced Repetition 牌组标签'), {
      target: { value: 'flashcards/英语' },
    })
    fireEvent.change(screen.getByLabelText('闪卡分隔语法'), {
      target: { value: 'bidirectional' },
    })
    fireEvent.click(screen.getByLabelText(/按词库分类拆分子牌组/))
    const audioCheckbox = screen.getByLabelText(/在笔记和闪卡中内嵌单词发音播放器/) as HTMLInputElement
    const autoplayCheckbox = screen.getByLabelText(/翻卡正面自动发音/) as HTMLInputElement
    expect(audioCheckbox.checked).toBe(true)
    expect(autoplayCheckbox.checked).toBe(true)
    fireEvent.click(autoplayCheckbox)
    fireEvent.click(screen.getByRole('button', { name: /测试 Obsidian 连通性/ }))

    await waitFor(() => {
      expect(screen.getByText(/连通成功/)).toBeInTheDocument()
    })
    expect(screen.getByText('浏览器直连')).toBeInTheDocument()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:27123/')
    expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer obs-secret-key')

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        obsidianSyncMode: 'rest_api',
        obsidianRestUrl: 'http://127.0.0.1:27123',
        obsidianRestApiKey: 'obs-secret-key',
        obsidianSrDeckTag: '#flashcards/英语',
        obsidianSrCardStyle: 'bidirectional',
        obsidianSrSubdeckByCategory: true,
        obsidianSrAudio: true,
        obsidianSrAudioAutoplay: false,
      }),
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
