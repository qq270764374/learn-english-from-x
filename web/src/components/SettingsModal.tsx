import { Activity, AlertCircle, CheckCircle2, Eye, EyeOff, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { testLlmConnection } from '../services/api'
import { normalizeSrDeckTag, testObsidianRestConnection } from '../services/obsidianRest'
import {
  FILTER_TIER_OPTIONS,
  getFilterTierOption,
  normalizeCustomFilterParams,
  type FilterTier,
  type LLMProvider,
  type LLMTestResponse,
  type ObsidianRestTestResponse,
  type ObsidianSrCardStyle,
  type ObsidianSyncMode,
  type UserSettings,
} from '../types/vocab'

interface SettingsModalProps {
  open: boolean
  settings: UserSettings
  backendOnline: boolean
  onBackendOnline?: () => void
  onSave: (next: UserSettings) => void
  onClose: () => void
}

function normalizeSavedSettings(draft: UserSettings): UserSettings {
  const customFilter = normalizeCustomFilterParams(draft)
  return {
    ...draft,
    ...customFilter,
    dailyNewLimit: Math.min(Math.max(Number(draft.dailyNewLimit) || 15, 3), 100),
    googleClientId: draft.googleClientId.trim(),
    llmBaseUrl: draft.llmBaseUrl.trim() || 'https://api.deepseek.com/v1',
    llmModel: draft.llmModel.trim() || 'deepseek-chat',
    geminiModel: draft.geminiModel.trim() || 'gemini-2.5-flash',
    obsidianSyncMode: draft.obsidianSyncMode || 'local_path',
    obsidianVaultPath: draft.obsidianVaultPath.trim(),
    obsidianRestUrl: (draft.obsidianRestUrl || '').trim().replace(/\/+$/, '') || 'https://127.0.0.1:27124',
    obsidianRestApiKey: (draft.obsidianRestApiKey || '').trim(),
    obsidianSubfolder: draft.obsidianSubfolder.trim() || 'X-Vocab',
    obsidianSrDeckTag: normalizeSrDeckTag(draft.obsidianSrDeckTag),
    obsidianSrCardStyle: draft.obsidianSrCardStyle || 'multiline',
    obsidianSrAudio: draft.obsidianSrAudio ?? true,
    obsidianSrAudioAutoplay: draft.obsidianSrAudioAutoplay ?? true,
  }
}

export function SettingsModal({
  open,
  settings,
  backendOnline,
  onBackendOnline,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [draft, setDraft] = useState<UserSettings>(settings)
  const [showKey, setShowKey] = useState(false)
  const [showObsidianKey, setShowObsidianKey] = useState(false)
  const [testingLlm, setTestingLlm] = useState(false)
  const [llmTestResult, setLlmTestResult] = useState<LLMTestResponse | null>(null)
  const [llmTestError, setLlmTestError] = useState('')
  const [testingObsidian, setTestingObsidian] = useState(false)
  const [obsidianTestResult, setObsidianTestResult] = useState<ObsidianRestTestResponse | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const clearLlmTestFeedback = () => {
    setLlmTestResult(null)
    setLlmTestError('')
  }

  const updateLlmDraft = (patch: Partial<UserSettings>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
    clearLlmTestFeedback()
  }

  const applyPreset = (preset: 'deepseek' | 'local_ollama' | 'openai' | 'gemini') => {
    clearLlmTestFeedback()
    if (preset === 'deepseek') {
      setDraft((prev) => ({
        ...prev,
        llmProvider: 'openai_compatible',
        llmBaseUrl: 'https://api.deepseek.com/v1',
        llmModel: 'deepseek-chat',
      }))
    } else if (preset === 'local_ollama') {
      setDraft((prev) => ({
        ...prev,
        llmProvider: 'openai_compatible',
        llmBaseUrl: 'http://localhost:11434/v1',
        llmModel: 'deepseek-r1:7b',
      }))
    } else if (preset === 'openai') {
      setDraft((prev) => ({
        ...prev,
        llmProvider: 'openai_compatible',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmModel: 'gpt-4o-mini',
      }))
    } else {
      setDraft((prev) => ({
        ...prev,
        llmProvider: 'gemini',
        geminiModel: 'gemini-2.5-flash',
      }))
    }
  }

  const handleTestLlm = async () => {
    setTestingLlm(true)
    clearLlmTestFeedback()
    try {
      const result = await testLlmConnection(draft)
      onBackendOnline?.()
      setLlmTestResult(result)
    } catch (err) {
      setLlmTestError(err instanceof Error ? err.message : '连通性测试失败，请检查本地后端与模型服务状态。')
    } finally {
      setTestingLlm(false)
    }
  }

  const updateObsidianRestDraft = (patch: Partial<UserSettings>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
    setObsidianTestResult(null)
  }

  const switchObsidianMode = (mode: ObsidianSyncMode) => {
    setDraft((prev) => ({
      ...prev,
      obsidianSyncMode: mode,
      obsidianRestUrl: prev.obsidianRestUrl || 'https://127.0.0.1:27124',
    }))
    setObsidianTestResult(null)
  }

  const handleTestObsidianRest = async () => {
    setTestingObsidian(true)
    setObsidianTestResult(null)
    try {
      const result = await testObsidianRestConnection({
        apiUrl: draft.obsidianRestUrl,
        apiKey: draft.obsidianRestApiKey,
        backendOnline,
      })
      if (result.via === 'backend') {
        onBackendOnline?.()
      }
      setObsidianTestResult(result)
    } finally {
      setTestingObsidian(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(normalizeSavedSettings(draft))
    onClose()
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-panel">
        <div className="modal-header">
          <h2 id="settings-modal-title" className="modal-title">
            系统与同步设置
          </h2>
          <button type="button" className="btn btn-ghost icon-btn" onClick={onClose} aria-label="关闭设置">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Section 1: LLM Provider */}
          <div className="form-section">
            <h3>1. 词卡大模型设置（生成中文释义与推文翻译）</h3>
            <div className="preset-row">
              <button
                type="button"
                className={`chip ${draft.llmProvider === 'openai_compatible' && draft.llmBaseUrl.includes('deepseek.com') ? 'active' : ''}`}
                onClick={() => applyPreset('deepseek')}
              >
                DeepSeek 云端（默认）
              </button>
              <button
                type="button"
                className={`chip ${draft.llmProvider === 'openai_compatible' && (draft.llmBaseUrl.includes('localhost') || draft.llmBaseUrl.includes('127.0.0.1')) ? 'active' : ''}`}
                onClick={() => applyPreset('local_ollama')}
              >
                本地自建 DeepSeek (Ollama)
              </button>
              <button
                type="button"
                className={`chip ${draft.llmProvider === 'gemini' ? 'active' : ''}`}
                onClick={() => applyPreset('gemini')}
              >
                Google Gemini
              </button>
              <button
                type="button"
                className={`chip ${draft.llmProvider === 'openai_compatible' && draft.llmBaseUrl.includes('openai.com') ? 'active' : ''}`}
                onClick={() => applyPreset('openai')}
              >
                OpenAI 兼容接口
              </button>
            </div>

            <div className="field">
              <label htmlFor="select-llm-provider">接口协议</label>
              <select
                id="select-llm-provider"
                className="select"
                value={draft.llmProvider}
                onChange={(e) => updateLlmDraft({ llmProvider: e.target.value as LLMProvider })}
              >
                <option value="openai_compatible">DeepSeek / OpenAI 兼容格式</option>
                <option value="gemini">Google Gemini API</option>
              </select>
            </div>

            {draft.llmProvider === 'openai_compatible' ? (
              <>
                <div className="field">
                  <label htmlFor="input-llm-base-url">API Base URL</label>
                  <input
                    id="input-llm-base-url"
                    className="input"
                    value={draft.llmBaseUrl}
                    onChange={(e) => updateLlmDraft({ llmBaseUrl: e.target.value })}
                    placeholder="https://api.deepseek.com/v1 或 http://localhost:11434/v1"
                  />
                </div>
                <div className="field">
                  <label htmlFor="input-llm-model">模型名称</label>
                  <input
                    id="input-llm-model"
                    className="input"
                    value={draft.llmModel}
                    onChange={(e) => updateLlmDraft({ llmModel: e.target.value })}
                    placeholder="deepseek-chat 或 deepseek-r1:7b"
                  />
                </div>
                <div className="field">
                  <label htmlFor="input-llm-key">API Key</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      id="input-llm-key"
                      className="input"
                      type={showKey ? 'text' : 'password'}
                      value={draft.llmApiKey}
                      onChange={(e) => updateLlmDraft({ llmApiKey: e.target.value })}
                      placeholder="sk-...（本地 Ollama / vLLM / LM Studio 可留空）"
                    />
                    <button type="button" className="btn icon-btn" onClick={() => setShowKey((s) => !s)} title="显示/隐藏密钥">
                      {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  <div className="field-hint">
                    使用本地自建 DeepSeek（Ollama / vLLM / LM Studio 等局域网服务）时，API Key 可直接留空；云端密钥仅保存在本地浏览器，也可在 <code>backend/.env</code> 配置。
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="input-gemini-model">Gemini 模型名称</label>
                  <input
                    id="input-gemini-model"
                    className="input"
                    value={draft.geminiModel}
                    onChange={(e) => updateLlmDraft({ geminiModel: e.target.value })}
                    placeholder="gemini-2.5-flash"
                  />
                </div>
                <div className="field">
                  <label htmlFor="input-gemini-key">Gemini API Key</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      id="input-gemini-key"
                      className="input"
                      type={showKey ? 'text' : 'password'}
                      value={draft.geminiApiKey}
                      onChange={(e) => updateLlmDraft({ geminiApiKey: e.target.value })}
                      placeholder="AIza..."
                    />
                    <button type="button" className="btn icon-btn" onClick={() => setShowKey((s) => !s)} title="显示/隐藏密钥">
                      {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
              </>
            )}

            <div className="llm-test-bar">
              <button
                id="btn-test-llm"
                type="button"
                className="btn btn-sm"
                disabled={testingLlm}
                onClick={() => void handleTestLlm()}
              >
                {testingLlm ? <Loader2 size={14} className="spin" /> : <Activity size={14} />}
                {testingLlm ? '正在测试连通性...' : '测试大模型连通性'}
              </button>
              <span className="field-hint" style={{ marginTop: 0 }}>
                {backendOnline
                  ? '将通过本地后端向当前所填地址发送极简探测请求，无需先保存。'
                  : '未检测到本地后端；若刚启动 start.sh 仍可直接点击测试。'}
              </span>
            </div>

            {llmTestError && (
              <div className="llm-test-result error" role="status">
                <div className="llm-test-title">
                  <AlertCircle size={15} />
                  <span>后端连接失败</span>
                </div>
                <div>{llmTestError}</div>
              </div>
            )}

            {llmTestResult && (
              <div className={`llm-test-result ${llmTestResult.ok ? 'success' : 'error'}`} role="status">
                <div className="llm-test-title">
                  {llmTestResult.ok ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                  <span>
                    {llmTestResult.ok
                      ? `连通成功 · ${llmTestResult.latency_ms} ms`
                      : `连通失败${llmTestResult.latency_ms > 0 ? ` · ${llmTestResult.latency_ms} ms` : ''}`}
                  </span>
                  {llmTestResult.is_local && <span className="tag">本地直连免代理</span>}
                </div>
                <div>{llmTestResult.message}</div>
                {llmTestResult.reply_preview && (
                  <div className="llm-test-meta">模型回复预览：{llmTestResult.reply_preview}</div>
                )}
                {!llmTestResult.ok && llmTestResult.endpoint && (
                  <div className="llm-test-meta">探测地址：{llmTestResult.endpoint}</div>
                )}
                {llmTestResult.available_models.length > 0 && (
                  <div className="llm-model-suggestions">
                    <span className="llm-test-meta">点击直接使用检测到的模型：</span>
                    <div className="preset-row" style={{ marginTop: 6, marginBottom: 0 }}>
                      {llmTestResult.available_models.slice(0, 8).map((modelId) => (
                        <button
                          key={modelId}
                          type="button"
                          className="chip"
                          onClick={() => updateLlmDraft({ llmModel: modelId })}
                        >
                          {modelId}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Section 2: Google Drive OAuth */}
          <div className="form-section">
            <h3>2. Google Drive 个人云端同步（可选）</h3>
            <div className="field">
              <label htmlFor="input-google-client-id">Google Cloud OAuth Client ID (Web 应用)</label>
              <input
                id="input-google-client-id"
                className="input"
                value={draft.googleClientId}
                onChange={(e) => setDraft({ ...draft, googleClientId: e.target.value })}
                placeholder="1234567890-xxxx.apps.googleusercontent.com"
              />
            </div>
            <div className="setup-guide">
              <strong>免费获取个人 OAuth Client ID 步骤：</strong>
              <ol>
                <li>登录 Google Cloud Console 新建项目，搜索并启用 <strong>Google Drive API</strong>。</li>
                <li>在“OAuth 同意屏幕”选“外部 (External)”，并在测试用户中添加您的 Gmail。</li>
                <li>前往“凭据 → 创建凭据 → OAuth 客户端 ID”，类型选择 <strong>Web 应用</strong>。</li>
                <li>在“已获授权的 JavaScript 来源”填入 <code>{window.location.origin}</code>（以及 <code>http://localhost:5173</code>），将生成的 Client ID 粘贴到上方即可。</li>
              </ol>
            </div>
          </div>

          {/* Section 3: Obsidian Vault Integration */}
          <div className="form-section">
            <h3>3. Obsidian 知识库连接（可选）</h3>
            <div className="preset-row">
              <button
                type="button"
                className={`chip ${draft.obsidianSyncMode !== 'rest_api' ? 'active' : ''}`}
                onClick={() => switchObsidianMode('local_path')}
              >
                本地目录直写
              </button>
              <button
                type="button"
                className={`chip ${draft.obsidianSyncMode === 'rest_api' ? 'active' : ''}`}
                onClick={() => switchObsidianMode('rest_api')}
              >
                Local REST API 插件
              </button>
            </div>

            {draft.obsidianSyncMode === 'rest_api' ? (
              <>
                <div className="preset-row" style={{ marginTop: -2 }}>
                  <button
                    type="button"
                    className={`chip ${draft.obsidianRestUrl.trim() === 'http://127.0.0.1:27123' ? 'active' : ''}`}
                    onClick={() => updateObsidianRestDraft({ obsidianRestUrl: 'http://127.0.0.1:27123' })}
                  >
                    HTTP 本地端口 (27123 · 纯前端直连)
                  </button>
                  <button
                    type="button"
                    className={`chip ${draft.obsidianRestUrl.trim() === 'https://127.0.0.1:27124' ? 'active' : ''}`}
                    onClick={() => updateObsidianRestDraft({ obsidianRestUrl: 'https://127.0.0.1:27124' })}
                  >
                    HTTPS 默认端口 (27124)
                  </button>
                </div>

                <div className="split-grid" style={{ gap: 12 }}>
                  <div className="field">
                    <label htmlFor="input-obsidian-rest-url">Obsidian REST API 地址</label>
                    <input
                      id="input-obsidian-rest-url"
                      className="input"
                      value={draft.obsidianRestUrl}
                      onChange={(e) => updateObsidianRestDraft({ obsidianRestUrl: e.target.value })}
                      placeholder="http://127.0.0.1:27123 或 https://127.0.0.1:27124"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="input-obsidian-subfolder">保存子目录名</label>
                    <input
                      id="input-obsidian-subfolder"
                      className="input"
                      value={draft.obsidianSubfolder}
                      onChange={(e) => setDraft({ ...draft, obsidianSubfolder: e.target.value })}
                      placeholder="X-Vocab"
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="input-obsidian-rest-key">Obsidian REST API Key（Bearer Token）</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      id="input-obsidian-rest-key"
                      className="input"
                      type={showObsidianKey ? 'text' : 'password'}
                      value={draft.obsidianRestApiKey}
                      onChange={(e) => updateObsidianRestDraft({ obsidianRestApiKey: e.target.value })}
                      placeholder="粘贴 Obsidian Local REST API 插件生成的密钥..."
                    />
                    <button
                      type="button"
                      className="btn icon-btn"
                      onClick={() => setShowObsidianKey((s) => !s)}
                      title="显示/隐藏 Obsidian API Key"
                    >
                      {showObsidianKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  <div className="field-hint">
                    在 Obsidian 安装 <strong>Local REST API</strong> 插件后，进入插件设置复制 API Key；若需免启动 Python 后端纯浏览器直连，建议开启插件的{' '}
                    <code>Enable Non-encrypted (HTTP) Server</code> 并使用 <code>27123</code> 端口。
                  </div>
                </div>

                <div className="llm-test-bar">
                  <button
                    id="btn-test-obsidian-rest"
                    type="button"
                    className="btn btn-sm"
                    disabled={testingObsidian}
                    onClick={() => void handleTestObsidianRest()}
                  >
                    {testingObsidian ? <Loader2 size={14} className="spin" /> : <Activity size={14} />}
                    {testingObsidian ? '正在检测 Obsidian...' : '测试 Obsidian 连通性'}
                  </button>
                  <span className="field-hint" style={{ marginTop: 0 }}>
                    会先尝试浏览器直连插件端口，若遇到自签名 HTTPS 证书拦截且本地后端在线将自动切换后端通道。
                  </span>
                </div>

                {obsidianTestResult && (
                  <div className={`llm-test-result ${obsidianTestResult.ok ? 'success' : 'error'}`} role="status">
                    <div className="llm-test-title">
                      {obsidianTestResult.ok ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                      <span>
                        {obsidianTestResult.ok
                          ? `连通成功${obsidianTestResult.latency_ms > 0 ? ` · ${obsidianTestResult.latency_ms} ms` : ''}`
                          : `连通失败${obsidianTestResult.latency_ms > 0 ? ` · ${obsidianTestResult.latency_ms} ms` : ''}`}
                      </span>
                      {obsidianTestResult.via && (
                        <span className="tag">
                          {obsidianTestResult.via === 'browser' ? '浏览器直连' : '本地后端代理'}
                        </span>
                      )}
                    </div>
                    <div>{obsidianTestResult.message}</div>
                  </div>
                )}
              </>
            ) : (
              <div className="split-grid" style={{ gap: 12 }}>
                <div className="field">
                  <label htmlFor="input-obsidian-vault">本机 Obsidian Vault 路径</label>
                  <input
                    id="input-obsidian-vault"
                    className="input"
                    value={draft.obsidianVaultPath}
                    onChange={(e) => setDraft({ ...draft, obsidianVaultPath: e.target.value })}
                    placeholder="例如 ~/Documents/MyVault 或 D:\Notes\English"
                  />
                </div>
                <div className="field">
                  <label htmlFor="input-obsidian-subfolder">保存子目录名</label>
                  <input
                    id="input-obsidian-subfolder"
                    className="input"
                    value={draft.obsidianSubfolder}
                    onChange={(e) => setDraft({ ...draft, obsidianSubfolder: e.target.value })}
                    placeholder="X-Vocab"
                  />
                </div>
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 8, cursor: 'pointer' }}>
              <input
                id="checkbox-obsidian-sr"
                type="checkbox"
                checked={draft.obsidianIncludeFlashcards}
                onChange={(e) => setDraft({ ...draft, obsidianIncludeFlashcards: e.target.checked })}
              />
              <span>接入 Obsidian <strong>Spaced Repetition</strong> 插件（生成闪卡并支持复习进度双向同步）</span>
            </label>

            {draft.obsidianIncludeFlashcards && (
              <div
                style={{
                  marginBottom: 10,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-subtle, rgba(128, 128, 128, 0.05))',
                }}
              >
                <div className="preset-row" style={{ marginBottom: 8 }}>
                  {['#flashcards/x-vocab', '#flashcards/英语词汇', '#flashcards'].map((presetTag) => (
                    <button
                      key={presetTag}
                      type="button"
                      className={`chip ${normalizeSrDeckTag(draft.obsidianSrDeckTag) === presetTag ? 'active' : ''}`}
                      onClick={() => setDraft({ ...draft, obsidianSrDeckTag: presetTag })}
                    >
                      {presetTag}
                    </button>
                  ))}
                </div>
                <div className="split-grid" style={{ gap: 12 }}>
                  <div className="field">
                    <label htmlFor="input-obsidian-sr-tag">Spaced Repetition 牌组标签</label>
                    <input
                      id="input-obsidian-sr-tag"
                      className="input"
                      value={draft.obsidianSrDeckTag}
                      onChange={(e) => setDraft({ ...draft, obsidianSrDeckTag: e.target.value })}
                      placeholder="#flashcards/x-vocab"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="select-obsidian-sr-style">闪卡分隔语法</label>
                    <select
                      id="select-obsidian-sr-style"
                      className="select"
                      value={draft.obsidianSrCardStyle}
                      onChange={(e) =>
                        setDraft({ ...draft, obsidianSrCardStyle: e.target.value as ObsidianSrCardStyle })
                      }
                    >
                      <option value="multiline">单向多行问答（? · 英 → 中）</option>
                      <option value="bidirectional">双向多行互测（?? · 英 ↔ 中）</option>
                      <option value="inline">单行紧凑速刷（:: · 适合单行卡片）</option>
                    </select>
                  </div>
                </div>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginBottom: 6, cursor: 'pointer' }}
                >
                  <input
                    id="checkbox-obsidian-sr-subdeck"
                    type="checkbox"
                    checked={draft.obsidianSrSubdeckByCategory}
                    onChange={(e) => setDraft({ ...draft, obsidianSrSubdeckByCategory: e.target.checked })}
                  />
                  <span>按词库分类拆分子牌组（自动追加 <code>/高频核心词</code>、<code>/地道搭配</code>、<code>/X网感俚语</code>）</span>
                </label>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginBottom: 6, cursor: 'pointer' }}
                >
                  <input
                    id="checkbox-obsidian-sr-progress"
                    type="checkbox"
                    checked={draft.obsidianSrSyncProgress}
                    onChange={(e) => setDraft({ ...draft, obsidianSrSyncProgress: e.target.checked })}
                  />
                  <span>将网页端已复习的 FSRS 进度映射写入初始 <code>&lt;!--SR:...--&gt;</code>（已有 Obsidian 进度始终保留）</span>
                </label>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12.5,
                    marginBottom: draft.obsidianSrAudio ? 6 : 0,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    id="checkbox-obsidian-sr-audio"
                    type="checkbox"
                    checked={draft.obsidianSrAudio}
                    onChange={(e) => setDraft({ ...draft, obsidianSrAudio: e.target.checked })}
                  />
                  <span>
                    在笔记和闪卡中内嵌单词发音播放器（<code>&lt;audio&gt;</code>，零本地存储占用 ·{' '}
                    {draft.ttsAccent === 'en-GB' ? '英音 UK' : '美音 US'}）
                  </span>
                </label>
                {draft.obsidianSrAudio && (
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 12.5,
                      paddingLeft: 20,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      id="checkbox-obsidian-sr-audio-autoplay"
                      type="checkbox"
                      checked={draft.obsidianSrAudioAutoplay}
                      onChange={(e) => setDraft({ ...draft, obsidianSrAudioAutoplay: e.target.checked })}
                    />
                    <span>
                      单向闪卡（<code>?</code> / <code>::</code>）翻卡正面自动发音（双向卡{' '}
                      <code>??</code> 与正文播放器保持手动点击，防止剧透英文答案）
                    </span>
                  </label>
                )}
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                id="checkbox-obsidian-autosync"
                type="checkbox"
                checked={draft.obsidianAutoSync}
                onChange={(e) => setDraft({ ...draft, obsidianAutoSync: e.target.checked })}
              />
              <span>AI 生成新词卡后自动同步写入 Obsidian（支持 Local REST API 直连或本机 Vault 路径）</span>
            </label>
          </div>

          {/* Section 4: Learning Preferences */}
          <div className="form-section">
            <h3>4. 学习与筛选偏好</h3>
            <div className="split-grid" style={{ gap: 12 }}>
              <div className="field">
                <label htmlFor="select-default-tier">默认词频过滤梯队</label>
                <select
                  id="select-default-tier"
                  className="select"
                  value={draft.filterTier}
                  onChange={(e) => setDraft({ ...draft, filterTier: e.target.value as FilterTier })}
                >
                  {FILTER_TIER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.settingLabel}
                    </option>
                  ))}
                </select>
                <div className="field-hint">{getFilterTierOption(draft.filterTier).description}</div>
              </div>
              <div className="field">
                <label htmlFor="input-daily-new">每日新词上限</label>
                <input
                  id="input-daily-new"
                  className="input"
                  type="number"
                  min={3}
                  max={100}
                  value={draft.dailyNewLimit}
                  onChange={(e) => setDraft({ ...draft, dailyNewLimit: Number(e.target.value) })}
                />
              </div>
            </div>

            {draft.filterTier === 'custom' && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 12,
                  marginBottom: 12,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-subtle, rgba(128, 128, 128, 0.05))',
                }}
              >
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="input-custom-vocab-limit">屏蔽前 N 高频词</label>
                  <input
                    id="input-custom-vocab-limit"
                    className="input"
                    type="number"
                    min={0}
                    max={25000}
                    step={500}
                    value={draft.customVocabLimit}
                    onChange={(e) => setDraft({ ...draft, customVocabLimit: Number(e.target.value) })}
                  />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="input-custom-zipf-min">Zipf 下限（更冷门）</label>
                  <input
                    id="input-custom-zipf-min"
                    className="input"
                    type="number"
                    min={1.0}
                    max={5.8}
                    step={0.1}
                    value={draft.customZipfMin}
                    onChange={(e) => setDraft({ ...draft, customZipfMin: Number(e.target.value) })}
                  />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="input-custom-zipf-max">Zipf 上限（更常见）</label>
                  <input
                    id="input-custom-zipf-max"
                    className="input"
                    type="number"
                    min={1.3}
                    max={6.5}
                    step={0.1}
                    value={draft.customZipfMax}
                    onChange={(e) => setDraft({ ...draft, customZipfMax: Number(e.target.value) })}
                  />
                </div>
              </div>
            )}

            <div className="field">
              <label htmlFor="select-tts-accent">标准发音口音（浏览器语音合成）</label>
              <select
                id="select-tts-accent"
                className="select"
                value={draft.ttsAccent}
                onChange={(e) => setDraft({ ...draft, ttsAccent: e.target.value as 'en-US' | 'en-GB' })}
              >
                <option value="en-US">美式英语 (en-US)</option>
                <option value="en-GB">英式英语 (en-GB)</option>
              </select>
            </div>

            <div className="field-hint">
              本地后端状态：{backendOnline ? '已连接 http://127.0.0.1:8765（NLP 分词、Obsidian 直写与 .apkg 导出就绪）' : '未检测到本地后端，当前处于离线复习/浏览模式'}
            </div>
          </div>

          <div className="toolbar-row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button id="btn-save-settings" type="submit" className="btn btn-primary">
              保存设置
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
