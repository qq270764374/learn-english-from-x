import type { ReviewLogEntry, SyncStateDocument, VocabCard } from '../types/vocab'

const DRIVE_FOLDER_NAME = 'LearnEnglishFromX_Data'
const DRIVE_STATE_FILENAME = 'vocab_state.json'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

interface GoogleTokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface GoogleTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            callback: (response: GoogleTokenResponse) => void
            error_callback?: (err: { type?: string; message?: string }) => void
          }) => GoogleTokenClient
        }
      }
    }
  }
}

let cachedToken: { token: string; expiresAt: number } | null = null

export function normalizeWordKey(word: string): string {
  return word.trim().toLowerCase()
}

function parseIsoMs(iso: string | undefined | null): number {
  if (!iso) return 0
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * Deterministically merge local browser state with remote Google Drive state.
 * Conflict rules:
 * - known_words, ignored_words, processed_tweet_ids: lossless set union
 * - cards (keyed by lowercased word): newer updated_at wins; tie-breaker keeps higher reps
 * - review_logs: deduplicated by (card_id, reviewed_at), sorted chronologically
 */
export function mergeSyncStates(local: SyncStateDocument, remote: SyncStateDocument): SyncStateDocument {
  const cardMap = new Map<string, VocabCard>()

  for (const card of local.cards) {
    cardMap.set(normalizeWordKey(card.word), card)
  }

  for (const remoteCard of remote.cards) {
    const key = normalizeWordKey(remoteCard.word)
    const existing = cardMap.get(key)
    if (!existing) {
      cardMap.set(key, remoteCard)
      continue
    }
    const remoteTime = parseIsoMs(remoteCard.updated_at)
    const localTime = parseIsoMs(existing.updated_at)
    if (
      remoteTime > localTime ||
      (remoteTime === localTime && (remoteCard.fsrs?.reps ?? 0) > (existing.fsrs?.reps ?? 0))
    ) {
      cardMap.set(key, remoteCard)
    }
  }

  const knownSet = new Set<string>([
    ...local.known_words.map(normalizeWordKey).filter(Boolean),
    ...remote.known_words.map(normalizeWordKey).filter(Boolean),
  ])

  const ignoredSet = new Set<string>([
    ...local.ignored_words.map(normalizeWordKey).filter(Boolean),
    ...remote.ignored_words.map(normalizeWordKey).filter(Boolean),
  ])

  const processedSet = new Set<string>([
    ...local.processed_tweet_ids.filter(Boolean),
    ...remote.processed_tweet_ids.filter(Boolean),
  ])

  const logMap = new Map<string, ReviewLogEntry>()
  for (const entry of local.review_logs) {
    logMap.set(`${entry.card_id}::${entry.reviewed_at}`, entry)
  }
  for (const entry of remote.review_logs) {
    logMap.set(`${entry.card_id}::${entry.reviewed_at}`, entry)
  }

  const mergedLogs = Array.from(logMap.values()).sort(
    (a, b) => parseIsoMs(a.reviewed_at) - parseIsoMs(b.reviewed_at),
  )

  const mergedCards = Array.from(cardMap.values()).sort(
    (a, b) => parseIsoMs(a.created_at) - parseIsoMs(b.created_at),
  )

  return {
    version: Math.max(local.version || 1, remote.version || 1),
    updated_at: new Date().toISOString(),
    cards: mergedCards,
    known_words: Array.from(knownSet).sort(),
    ignored_words: Array.from(ignoredSet).sort(),
    processed_tweet_ids: Array.from(processedSet).sort(),
    review_logs: mergedLogs,
  }
}

export function clearGoogleTokenCache(): void {
  cachedToken = null
}

export function hasActiveGoogleToken(): boolean {
  return Boolean(cachedToken && Date.now() < cachedToken.expiresAt - 60_000)
}

export function requestGoogleAccessToken(clientId: string, promptConsent = false): Promise<string> {
  const trimmedId = clientId.trim()
  if (!trimmedId) {
    return Promise.reject(new Error('请先在“设置”中填写您个人的 Google Cloud OAuth Client ID。'))
  }
  if (!promptConsent && cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return Promise.resolve(cachedToken.token)
  }
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) {
    return Promise.reject(new Error('Google 登录组件仍在加载或被网络拦截，请稍后再试，或先使用本地/JSON 备份。'))
  }

  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: trimmedId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || 'Google 授权被取消或失败'))
          return
        }
        const expiresSec = Number(response.expires_in) || 3500
        cachedToken = {
          token: response.access_token,
          expiresAt: Date.now() + expiresSec * 1000,
        }
        resolve(response.access_token)
      },
      error_callback: (err) => {
        reject(new Error(err.message || err.type || '无法打开 Google 授权窗口'))
      },
    })
    client.requestAccessToken({ prompt: promptConsent ? 'consent' : '' })
  })
}

async function driveFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  const resp = await fetch(url, { ...init, headers })
  if (resp.status === 401) {
    clearGoogleTokenCache()
    throw new Error('Google Drive 授权已过期，请点击“立即同步”重新授权。')
  }
  return resp
}

async function ensureAppFolder(token: string): Promise<string> {
  const q = encodeURIComponent(
    `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  )
  const listResp = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`,
    token,
  )
  if (!listResp.ok) {
    throw new Error(`查询 Google Drive 目录失败 (HTTP ${listResp.status})`)
  }
  const listData = (await listResp.json()) as { files?: Array<{ id: string; name: string }> }
  if (listData.files && listData.files.length > 0) {
    return listData.files[0].id
  }

  const createResp = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  })
  if (!createResp.ok) {
    throw new Error(`创建 Google Drive 目录失败 (HTTP ${createResp.status})`)
  }
  const created = (await createResp.json()) as { id: string }
  return created.id
}

async function findStateFileId(token: string, folderId: string, knownFileId?: string): Promise<string | null> {
  if (knownFileId) {
    const checkResp = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(knownFileId)}?fields=id,trashed`,
      token,
    )
    if (checkResp.ok) {
      const meta = (await checkResp.json()) as { id: string; trashed?: boolean }
      if (!meta.trashed) return meta.id
    }
  }

  const q = encodeURIComponent(
    `name='${DRIVE_STATE_FILENAME}' and '${folderId}' in parents and trashed=false`,
  )
  const resp = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&spaces=drive`,
    token,
  )
  if (!resp.ok) {
    throw new Error(`查找同步文件失败 (HTTP ${resp.status})`)
  }
  const data = (await resp.json()) as { files?: Array<{ id: string }> }
  return data.files && data.files.length > 0 ? data.files[0].id : null
}

async function downloadRemoteState(token: string, fileId: string): Promise<SyncStateDocument | null> {
  const resp = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    token,
  )
  if (!resp.ok) {
    throw new Error(`下载云端词库失败 (HTTP ${resp.status})`)
  }
  const text = await resp.text()
  if (!text.trim()) return null
  return JSON.parse(text) as SyncStateDocument
}

async function uploadStateFile(
  token: string,
  state: SyncStateDocument,
  folderId: string,
  existingFileId: string | null,
): Promise<string> {
  const boundary = `lex_boundary_${Date.now()}`
  const metadata = existingFileId
    ? { name: DRIVE_STATE_FILENAME }
    : { name: DRIVE_STATE_FILENAME, parents: [folderId] }

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(state, null, 2)}\r\n` +
    `--${boundary}--`

  const uploadUrl = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=id`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id'

  const resp = await driveFetch(uploadUrl, token, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })
  if (!resp.ok) {
    throw new Error(`上传同步文件到 Google Drive 失败 (HTTP ${resp.status})`)
  }
  const data = (await resp.json()) as { id: string }
  return data.id
}

export async function syncWithGoogleDrive(
  localState: SyncStateDocument,
  options: { clientId: string; knownFileId?: string; promptConsent?: boolean },
): Promise<{
  mergedState: SyncStateDocument
  fileId: string
  syncedAt: string
}> {
  const token = await requestGoogleAccessToken(options.clientId, options.promptConsent)
  const folderId = await ensureAppFolder(token)
  const existingFileId = await findStateFileId(token, folderId, options.knownFileId)

  let mergedState = localState
  if (existingFileId) {
    const remote = await downloadRemoteState(token, existingFileId)
    if (remote && Array.isArray(remote.cards)) {
      mergedState = mergeSyncStates(localState, remote)
    }
  }

  const savedFileId = await uploadStateFile(token, mergedState, folderId, existingFileId)
  return {
    mergedState,
    fileId: savedFileId,
    syncedAt: new Date().toISOString(),
  }
}
