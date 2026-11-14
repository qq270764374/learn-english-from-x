import { Eye, EyeOff, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FilterTier, LLMProvider, UserSettings } from '../types/vocab'

interface SettingsModalProps {
  open: boolean
  settings: UserSettings
  backendOnline: boolean
  onSave: (next: UserSettings) => void
  onClose: () => void
}

export function SettingsModal({
  open,
  settings,
  backendOnline,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [draft, setDraft] = useState<UserSettings>(settings)
  const [showKey, setShowKey] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const applyPreset = (preset: 'deepseek' | 'local_ollama' | 'openai' | 'gemini') => {
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({
      ...draft,
      dailyNewLimit: Math.min(Math.max(Number(draft.dailyNewLimit) || 15, 3), 100),
      googleClientId: draft.googleClientId.trim(),
      llmBaseUrl: draft.llmBaseUrl.trim() || 'https://api.deepseek.com/v1',
      llmModel: draft.llmModel.trim() || 'deepseek-chat',
      geminiModel: draft.geminiModel.trim() || 'gemini-2.5-flash',
      obsidianVaultPath: draft.obsidianVaultPath.trim(),
      obsidianSubfolder: draft.obsidianSubfolder.trim() || 'X-Vocab',
    })
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
                onChange={(e) => setDraft({ ...draft, llmProvider: e.target.value as LLMProvider })}
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
                    onChange={(e) => setDraft({ ...draft, llmBaseUrl: e.target.value })}
                    placeholder="https://api.deepseek.com/v1 或 http://localhost:11434/v1"
                  />
                </div>
                <div className="field">
                  <label htmlFor="input-llm-model">模型名称</label>
                  <input
                    id="input-llm-model"
                    className="input"
                    value={draft.llmModel}
                    onChange={(e) => setDraft({ ...draft, llmModel: e.target.value })}
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
                      onChange={(e) => setDraft({ ...draft, llmApiKey: e.target.value })}
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
                    onChange={(e) => setDraft({ ...draft, geminiModel: e.target.value })}
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
                      onChange={(e) => setDraft({ ...draft, geminiApiKey: e.target.value })}
                      placeholder="AIza..."
                    />
                    <button type="button" className="btn icon-btn" onClick={() => setShowKey((s) => !s)} title="显示/隐藏密钥">
                      {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
              </>
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
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 8, cursor: 'pointer' }}>
              <input
                id="checkbox-obsidian-sr"
                type="checkbox"
                checked={draft.obsidianIncludeFlashcards}
                onChange={(e) => setDraft({ ...draft, obsidianIncludeFlashcards: e.target.checked })}
              />
              <span>附带 Spaced Repetition 插件闪卡格式（<code>#flashcards/x-vocab</code>）</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                id="checkbox-obsidian-autosync"
                type="checkbox"
                checked={draft.obsidianAutoSync}
                onChange={(e) => setDraft({ ...draft, obsidianAutoSync: e.target.checked })}
              />
              <span>AI 生成新词卡后自动同步写入 Obsidian Vault（需填写路径且本地后端在线）</span>
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
                  <option value="strict_1200">核心 1200 词</option>
                  <option value="basic_2000">基础 2000 词（推荐四级以下）</option>
                  <option value="cet4_3500">四级 3500 词</option>
                </select>
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
