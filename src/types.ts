export interface AuthData {
  idToken: string
  accessToken: string
  refreshToken: string
  accountId?: string
  defaultOrganizationId?: string
  defaultOrganizationTitle?: string
  chatgptUserId?: string
  userId?: string
  subject?: string
  email: string
  planType: string
  authJson?: Record<string, unknown>
}

export type StorageMode = 'auto' | 'secretStorage' | 'remoteFiles'

export interface ProfileSummary {
  id: string
  name: string
  email: string
  planType: string
  accountId?: string
  defaultOrganizationId?: string
  defaultOrganizationTitle?: string
  chatgptUserId?: string
  userId?: string
  subject?: string
  createdAt: string
  updatedAt: string
}

export interface TokenStatus {
  expiresAt: number | null
  isExpired: boolean
  label: string
}

export interface RefreshTokenStatus {
  available: boolean
  label: string
}

export interface QuotaWindowInfo {
  usedPercent: number
  remainingPercent: number
  resetsAt: number | null
  windowSeconds: number | null
}

export type QuotaUnavailableCode =
  | 'workspace_deactivated'
  | 'missing_auth_tokens'
  | 'invalid_auth_token'
  | 'request_failed'

export interface QuotaUnavailableReason {
  code: QuotaUnavailableCode
  message: string
  statusCode: number | null
}

export interface QuotaInfo {
  plan: string
  email: string
  tokenExpired: boolean
  primaryWindow: QuotaWindowInfo | null
  secondaryWindow: QuotaWindowInfo | null
  unavailableReason: QuotaUnavailableReason | null
}

export interface ProfileHealthState {
  profileId: string
  authAvailable: boolean
  authErrorMessage?: string
  tokenStatus: TokenStatus | null
  refreshTokenStatus: RefreshTokenStatus
  lastRenewedAt: string | null
  tokenRenewErrorMessage?: string
  quotaInfo: QuotaInfo | null
  quotaLoading: boolean
  quotaErrorMessage?: string
  tokenRefreshInProgress: boolean
  updatedAt: number | null
}
