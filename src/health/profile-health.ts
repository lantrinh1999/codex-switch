import * as https from 'https'
import {
  AuthData,
  ProfileHealthState,
  ProfileSummary,
  QuotaInfo,
  QuotaUnavailableReason,
  QuotaWindowInfo,
  RefreshTokenStatus,
  TokenStatus,
} from '../types'
import { loadAuthDataFromJson, parseJWT } from '../auth/auth-parser'

const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

interface RateLimitWindow {
  used_percent: number
  reset_at: number | null
  limit_window_seconds?: number
}

interface UsageApiResponse {
  plan_type?: string
  rate_limit?: {
    primary_window?: RateLimitWindow
    secondary_window?: RateLimitWindow
  }
}

interface RefreshResponse {
  id_token?: string
  access_token?: string
  refresh_token?: string
}

export interface AuthPayload {
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
  [key: string]: unknown
}

export interface HttpResponse {
  statusCode: number
  body: string
}

export interface HttpTransport {
  get(url: string, headers: Record<string, string>): Promise<HttpResponse>
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<HttpResponse>
}

interface HttpErrorLike {
  statusCode?: number
  body?: string
  message?: string
}

function request(
  method: 'GET' | 'POST',
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        let responseBody = ''
        res.on('data', (chunk) => {
          responseBody += String(chunk)
        })
        res.on('end', () => {
          const statusCode = res.statusCode || 0
          if (statusCode >= 200 && statusCode < 300) {
            resolve({ statusCode, body: responseBody })
            return
          }

          reject({
            statusCode,
            body: responseBody,
            message: `HTTP ${statusCode}`,
          } satisfies HttpErrorLike)
        })
      },
    )

    req.on('error', reject)
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timeout'))
    })
    if (body) {
      req.write(body)
    }
    req.end()
  })
}

export const defaultHttpTransport: HttpTransport = {
  async get(url, headers) {
    return request('GET', url, undefined, headers)
  },
  async post(url, body, headers) {
    return request('POST', url, body, headers)
  },
}

function clonePayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function getJwtExpiry(token: string | undefined): Date | null {
  if (!token) {
    return null
  }

  const payload = parseJWT(token)
  const exp = payload.exp
  if (typeof exp !== 'number') {
    return null
  }
  return new Date(exp * 1000)
}

function getPlanFromPayload(payload: AuthPayload): string {
  const idTokenPayload = parseJWT(payload.tokens?.id_token || '')
  const authPayload = idTokenPayload['https://api.openai.com/auth']
  if (
    !authPayload ||
    typeof authPayload !== 'object' ||
    Array.isArray(authPayload)
  ) {
    return 'Unknown'
  }

  const plan = (authPayload as Record<string, unknown>).chatgpt_plan_type
  return typeof plan === 'string' && plan.trim() ? plan.trim() : 'Unknown'
}

function getEmailFromPayload(payload: AuthPayload): string {
  const idTokenPayload = parseJWT(payload.tokens?.id_token || '')
  const email = idTokenPayload.email
  return typeof email === 'string' && email.trim() ? email.trim() : 'Unknown'
}

function parseWindow(
  window: RateLimitWindow | undefined,
): QuotaWindowInfo | null {
  if (!window) {
    return null
  }

  const usedPercent = Number(window.used_percent)
  if (!Number.isFinite(usedPercent)) {
    return null
  }

  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - Math.round(usedPercent)),
    resetsAt:
      typeof window.reset_at === 'number' && Number.isFinite(window.reset_at)
        ? window.reset_at * 1000
        : null,
    windowSeconds:
      typeof window.limit_window_seconds === 'number'
        ? window.limit_window_seconds
        : null,
  }
}

function parseUnavailableReason(
  payload: AuthPayload,
  error: unknown,
): QuotaUnavailableReason {
  if (!payload.tokens?.access_token) {
    return {
      code: 'missing_auth_tokens',
      message: 'Missing auth tokens',
      statusCode: null,
    }
  }

  const httpError = error as HttpErrorLike
  const statusCode =
    typeof httpError.statusCode === 'number' ? httpError.statusCode : null

  if (typeof httpError.body === 'string' && httpError.body) {
    try {
      const parsed = JSON.parse(httpError.body) as {
        detail?: string | { code?: string }
      }
      if (
        parsed.detail &&
        typeof parsed.detail === 'object' &&
        parsed.detail.code === 'deactivated_workspace'
      ) {
        return {
          code: 'workspace_deactivated',
          message: 'Workspace deactivated',
          statusCode,
        }
      }

      if (
        typeof parsed.detail === 'string' &&
        /authentication token/i.test(parsed.detail)
      ) {
        return {
          code: 'invalid_auth_token',
          message: 'Missing auth tokens',
          statusCode,
        }
      }
    } catch {
      // ignore parse failures
    }
  }

  if (httpError.message === 'No access_token in auth file') {
    return {
      code: 'missing_auth_tokens',
      message: 'Missing auth tokens',
      statusCode,
    }
  }

  return {
    code: 'request_failed',
    message: 'Quota unavailable',
    statusCode,
  }
}

function createUnavailableQuotaInfo(
  payload: AuthPayload,
  error: unknown,
): QuotaInfo {
  return {
    plan: getPlanFromPayload(payload),
    email: getEmailFromPayload(payload),
    tokenExpired: isAuthPayloadTokenExpired(payload),
    primaryWindow: null,
    secondaryWindow: null,
    unavailableReason: parseUnavailableReason(payload, error),
  }
}

export function formatExpiry(expiry: Date | null, now = Date.now()): string {
  if (!expiry) {
    return 'unknown'
  }

  const diff = expiry.getTime() - now
  if (diff <= 0) {
    const agoMinutes = Math.floor(Math.abs(diff) / 60000)
    if (agoMinutes < 60) {
      return `expired ${agoMinutes}m ago`
    }

    const hours = Math.floor(agoMinutes / 60)
    if (hours < 24) {
      return `expired ${hours}h${agoMinutes % 60}m ago`
    }

    return `expired ${Math.floor(hours / 24)}d${hours % 24}h ago`
  }

  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) {
    return `expires in ${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `expires in ${hours}h${minutes % 60}m`
  }

  return `expires in ${Math.floor(hours / 24)}d${hours % 24}h`
}

export function getTokenStatus(
  authData: AuthData,
  now = Date.now(),
): TokenStatus {
  const expiry = getJwtExpiry(authData.accessToken)
  return {
    expiresAt: expiry ? expiry.getTime() : null,
    isExpired: !expiry || expiry.getTime() < now,
    label: formatExpiry(expiry, now),
  }
}

export function getRefreshTokenStatus(authData: AuthData): RefreshTokenStatus {
  const available = Boolean(
    authData.refreshToken && authData.refreshToken.trim(),
  )
  return {
    available,
    label: available ? 'available' : 'missing',
  }
}

export function isAuthPayloadTokenExpired(payload: AuthPayload): boolean {
  const expiry = getJwtExpiry(payload.tokens?.access_token)
  if (!expiry) {
    return true
  }
  return expiry.getTime() < Date.now()
}

export function buildAuthPayload(authData: AuthData): AuthPayload {
  const payload =
    authData.authJson && typeof authData.authJson === 'object'
      ? clonePayload(authData.authJson)
      : {}

  const nextPayload =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as AuthPayload)
      : {}

  if (!nextPayload.tokens || typeof nextPayload.tokens !== 'object') {
    nextPayload.tokens = {}
  }

  nextPayload.tokens.id_token = authData.idToken
  nextPayload.tokens.access_token = authData.accessToken
  nextPayload.tokens.refresh_token = authData.refreshToken
  if (authData.accountId) {
    nextPayload.tokens.account_id = authData.accountId
  }

  return nextPayload
}

export function authDataFromPayload(
  payload: AuthPayload,
  fallback: AuthData,
): AuthData {
  const parsed = loadAuthDataFromJson(payload)
  if (parsed) {
    return parsed
  }

  return {
    ...fallback,
    idToken: payload.tokens?.id_token || fallback.idToken,
    accessToken: payload.tokens?.access_token || fallback.accessToken,
    refreshToken: payload.tokens?.refresh_token || fallback.refreshToken,
    accountId: payload.tokens?.account_id || fallback.accountId,
    authJson: clonePayload(payload) as Record<string, unknown>,
  }
}

export async function refreshAccessTokenPayload(
  payload: AuthPayload,
  transport: HttpTransport = defaultHttpTransport,
): Promise<AuthPayload> {
  const refreshToken = payload.tokens?.refresh_token
  if (!refreshToken) {
    throw new Error('No refresh_token in auth file')
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }).toString()

  const response = await transport.post(TOKEN_URL, body, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': String(Buffer.byteLength(body)),
  })

  const parsed = JSON.parse(response.body) as RefreshResponse
  payload.tokens ??= {}
  if (parsed.access_token) {
    payload.tokens.access_token = parsed.access_token
  }
  if (parsed.refresh_token) {
    payload.tokens.refresh_token = parsed.refresh_token
  }
  if (parsed.id_token) {
    payload.tokens.id_token = parsed.id_token
  }
  payload.last_refresh = new Date().toISOString()
  return payload
}

async function requestUsageApi(
  payload: AuthPayload,
  transport: HttpTransport,
): Promise<UsageApiResponse> {
  const accessToken = payload.tokens?.access_token
  if (!accessToken) {
    throw new Error('No access_token in auth file')
  }

  const response = await transport.get(USAGE_URL, {
    Authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': payload.tokens?.account_id || '',
    'User-Agent': 'codex-switch/1.0',
    Accept: 'application/json',
  })
  return JSON.parse(response.body) as UsageApiResponse
}

export async function fetchQuotaInfo(
  payload: AuthPayload,
  transport: HttpTransport = defaultHttpTransport,
): Promise<{ payload: AuthPayload; quotaInfo: QuotaInfo }> {
  try {
    const apiData = await requestUsageApi(payload, transport)
    return {
      payload,
      quotaInfo: {
        plan:
          typeof apiData.plan_type === 'string' && apiData.plan_type.trim()
            ? apiData.plan_type.trim()
            : getPlanFromPayload(payload),
        email: getEmailFromPayload(payload),
        tokenExpired: isAuthPayloadTokenExpired(payload),
        primaryWindow: parseWindow(apiData.rate_limit?.primary_window),
        secondaryWindow: parseWindow(apiData.rate_limit?.secondary_window),
        unavailableReason: null,
      },
    }
  } catch (error) {
    const httpError = error as HttpErrorLike
    if (httpError.statusCode === 401 || httpError.statusCode === 403) {
      try {
        await refreshAccessTokenPayload(payload, transport)
        const apiData = await requestUsageApi(payload, transport)
        return {
          payload,
          quotaInfo: {
            plan:
              typeof apiData.plan_type === 'string' && apiData.plan_type.trim()
                ? apiData.plan_type.trim()
                : getPlanFromPayload(payload),
            email: getEmailFromPayload(payload),
            tokenExpired: isAuthPayloadTokenExpired(payload),
            primaryWindow: parseWindow(apiData.rate_limit?.primary_window),
            secondaryWindow: parseWindow(apiData.rate_limit?.secondary_window),
            unavailableReason: null,
          },
        }
      } catch (retryError) {
        return {
          payload,
          quotaInfo: createUnavailableQuotaInfo(payload, retryError),
        }
      }
    }

    return {
      payload,
      quotaInfo: createUnavailableQuotaInfo(payload, error),
    }
  }
}

export function getQuotaWindowLabel(window: QuotaWindowInfo): string {
  if (window.windowSeconds == null) {
    return 'Quota'
  }

  const hours = window.windowSeconds / 3600
  if (hours <= 5) {
    return '5h'
  }
  if (hours <= 24) {
    return `${Math.round(hours)}h`
  }
  return `${Math.round(hours / 24)}d`
}

export function formatResetTime(
  resetsAt: number | null,
  now = Date.now(),
): string | null {
  if (!resetsAt) {
    return null
  }

  const seconds = Math.floor((resetsAt - now) / 1000)
  if (seconds <= 0) {
    return 'Resets soon'
  }

  const hours = Math.floor(seconds / 3600)
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return `Resets in ${days}d${hours % 24}h`
  }
  if (hours >= 1) {
    return `Resets in ${hours}h`
  }
  return 'Resets in <1h'
}

export function formatQuotaWindowDescription(
  window: QuotaWindowInfo,
  now = Date.now(),
): string {
  const resetText = formatResetTime(window.resetsAt, now)
  if (resetText) {
    return `${window.remainingPercent}% remaining · ${resetText}`
  }
  return `${window.remainingPercent}% remaining`
}

export function formatQuotaSummary(info: QuotaInfo | null): string | null {
  if (!info?.primaryWindow) {
    return null
  }

  const parts = [
    `${getQuotaWindowLabel(info.primaryWindow)} ${info.primaryWindow.remainingPercent}%`,
  ]
  if (info.secondaryWindow) {
    parts.push(
      `${getQuotaWindowLabel(info.secondaryWindow)} ${info.secondaryWindow.remainingPercent}%`,
    )
  }

  return parts.join(' · ')
}

function quotaRemaining(window: QuotaWindowInfo | null | undefined): number {
  return window?.remainingPercent ?? -1
}

export function pickBestQuotaProfileId(
  profiles: ProfileSummary[],
  healthStates: ReadonlyMap<string, ProfileHealthState>,
  activeProfileId?: string,
): string | undefined {
  const ranked = [...profiles]
    .map((profile) => ({
      profile,
      state: healthStates.get(profile.id),
    }))
    .filter((entry) => Boolean(entry.state?.quotaInfo?.primaryWindow))
    .sort((left, right) => {
      const leftPrimary = quotaRemaining(left.state?.quotaInfo?.primaryWindow)
      const rightPrimary = quotaRemaining(right.state?.quotaInfo?.primaryWindow)
      if (leftPrimary !== rightPrimary) {
        return rightPrimary - leftPrimary
      }

      const leftSecondary = quotaRemaining(
        left.state?.quotaInfo?.secondaryWindow,
      )
      const rightSecondary = quotaRemaining(
        right.state?.quotaInfo?.secondaryWindow,
      )
      if (leftSecondary !== rightSecondary) {
        return rightSecondary - leftSecondary
      }

      const leftIsActive = left.profile.id === activeProfileId ? 1 : 0
      const rightIsActive = right.profile.id === activeProfileId ? 1 : 0
      if (leftIsActive !== rightIsActive) {
        return rightIsActive - leftIsActive
      }

      return left.profile.name.localeCompare(right.profile.name)
    })

  return ranked[0]?.profile.id
}
