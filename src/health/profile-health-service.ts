import * as vscode from 'vscode'
import { ProfileManager } from '../auth/profile-manager'
import {
  AuthData,
  ProfileHealthState,
  ProfileSummary,
  RefreshTokenStatus,
} from '../types'
import {
  authDataFromPayload,
  buildAuthPayload,
  fetchQuotaInfo,
  getLastRefreshTimestamp,
  getRefreshTokenStatus,
  getTokenStatus,
  isTokenRenewDue,
  refreshAccessTokenPayload,
} from './profile-health'

const TOKEN_AUTO_RENEW_MINIMUM_MINUTES = 5
const TOKEN_AUTO_RENEW_DEFAULT_MINUTES = 60
const QUOTA_REFRESH_DEFAULT_SECONDS = 300
const STARTUP_TOKEN_RENEW_DELAY_MS = 0

function createDefaultRefreshTokenStatus(): RefreshTokenStatus {
  return {
    available: false,
    label: 'missing',
  }
}

function getComparableLastRefresh(
  auth: Pick<AuthData, 'authJson'>,
): string | null {
  const raw = auth.authJson?.last_refresh
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function sameAuth(
  left: Pick<AuthData, 'idToken' | 'accessToken' | 'refreshToken' | 'authJson'>,
  right: Pick<
    AuthData,
    'idToken' | 'accessToken' | 'refreshToken' | 'authJson'
  >,
): boolean {
  return (
    left.idToken === right.idToken &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    getComparableLastRefresh(left) === getComparableLastRefresh(right)
  )
}

interface RefreshTokenOptions {
  automatic?: boolean
}

export class ProfileHealthService implements vscode.Disposable {
  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<
    string | undefined
  >()

  readonly onDidChangeState = this.onDidChangeStateEmitter.event

  private readonly states = new Map<string, ProfileHealthState>()
  private readonly quotaRefreshes = new Map<string, Promise<void>>()
  private readonly tokenRefreshes = new Map<string, Promise<boolean>>()
  private quotaTimer: ReturnType<typeof setInterval> | undefined
  private tokenRenewTimer: ReturnType<typeof setInterval> | undefined
  private startupTokenRenewTimer: ReturnType<typeof setTimeout> | undefined
  private readonly configurationListener: vscode.Disposable

  constructor(private readonly profileManager: ProfileManager) {
    this.restartQuotaTimer()
    this.restartTokenRenewTimer()
    this.scheduleDeferredTokenRenewSweep()
    this.configurationListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration('codexSwitch.quotaRefreshInterval')) {
          this.restartQuotaTimer()
        }

        if (
          event.affectsConfiguration('codexSwitch.autoRenewTokens') ||
          event.affectsConfiguration(
            'codexSwitch.tokenAutoRenewIntervalMinutes',
          )
        ) {
          this.restartTokenRenewTimer()
          this.scheduleDeferredTokenRenewSweep()
        }
      },
    )
  }

  dispose(): void {
    if (this.quotaTimer) {
      clearInterval(this.quotaTimer)
    }
    if (this.tokenRenewTimer) {
      clearInterval(this.tokenRenewTimer)
    }
    if (this.startupTokenRenewTimer) {
      clearTimeout(this.startupTokenRenewTimer)
    }
    this.configurationListener.dispose()
    this.onDidChangeStateEmitter.dispose()
  }

  getState(profileId: string): ProfileHealthState | undefined {
    return this.states.get(profileId)
  }

  getStates(): ReadonlyMap<string, ProfileHealthState> {
    return this.states
  }

  async primeProfiles(profiles: ProfileSummary[]): Promise<void> {
    const validIds = new Set(profiles.map((profile) => profile.id))
    for (const profileId of [...this.states.keys()]) {
      if (!validIds.has(profileId)) {
        this.states.delete(profileId)
      }
    }

    for (const profile of profiles) {
      await this.updateLocalState(profile.id, false)
    }
  }

  async refreshAll(): Promise<void> {
    const profiles = await this.profileManager.listProfiles()
    await this.primeProfiles(profiles)
    await Promise.all(profiles.map((profile) => this.refreshQuota(profile.id)))
  }

  async refreshAllQuotas(): Promise<void> {
    let profileIds = [...this.states.keys()]
    if (profileIds.length === 0) {
      const profiles = await this.profileManager.listProfiles()
      await this.primeProfiles(profiles)
      profileIds = profiles.map((profile) => profile.id)
    }

    await Promise.all(
      profileIds.map((profileId) => this.refreshQuota(profileId)),
    )
  }

  async refreshDueTokens(): Promise<void> {
    if (!this.isTokenAutoRenewEnabled()) {
      return
    }

    const profiles = await this.profileManager.listProfiles()
    await this.primeProfiles(profiles)

    const intervalMinutes = this.getTokenAutoRenewIntervalMinutes()
    for (const profile of profiles) {
      const authData = await this.profileManager.loadAuthData(profile.id)
      if (!authData || !isTokenRenewDue(authData, intervalMinutes)) {
        continue
      }

      await this.refreshToken(profile.id, { automatic: true })
    }
  }

  async refreshQuota(profileId: string): Promise<void> {
    const existing = this.quotaRefreshes.get(profileId)
    if (existing) {
      return existing
    }

    const promise = this.doRefreshQuota(profileId).finally(() => {
      this.quotaRefreshes.delete(profileId)
    })
    this.quotaRefreshes.set(profileId, promise)
    return promise
  }

  async refreshToken(
    profileId: string,
    options?: RefreshTokenOptions,
  ): Promise<boolean> {
    const existing = this.tokenRefreshes.get(profileId)
    if (existing) {
      return existing
    }

    const promise = this.doRefreshToken(profileId, options).finally(() => {
      this.tokenRefreshes.delete(profileId)
    })
    this.tokenRefreshes.set(profileId, promise)
    return promise
  }

  private async doRefreshQuota(profileId: string): Promise<void> {
    const current =
      this.states.get(profileId) || this.createBaseState(profileId)
    this.states.set(profileId, {
      ...current,
      quotaLoading: true,
      quotaErrorMessage: undefined,
    })
    this.onDidChangeStateEmitter.fire(profileId)

    const authData = await this.profileManager.loadAuthData(profileId)
    if (!authData) {
      this.states.set(profileId, {
        ...this.createBaseState(profileId),
        authAvailable: false,
        authErrorMessage: 'Stored auth unavailable',
        quotaLoading: false,
        quotaErrorMessage: 'Stored auth unavailable',
      })
      this.onDidChangeStateEmitter.fire(profileId)
      return
    }

    try {
      const { payload, quotaInfo } = await fetchQuotaInfo(
        buildAuthPayload(authData),
      )
      const nextAuthData = authDataFromPayload(payload, authData)
      await this.persistAuthIfChanged(profileId, authData, nextAuthData)

      const nextLastRenewedAt = getLastRefreshTimestamp(nextAuthData)
      const renewedDuringQuotaRefresh =
        Boolean(nextLastRenewedAt) &&
        nextLastRenewedAt !== current.lastRenewedAt

      this.states.set(profileId, {
        ...current,
        profileId,
        authAvailable: true,
        authErrorMessage: undefined,
        tokenStatus: getTokenStatus(nextAuthData),
        refreshTokenStatus: getRefreshTokenStatus(nextAuthData),
        lastRenewedAt: nextLastRenewedAt,
        tokenRenewErrorMessage: renewedDuringQuotaRefresh
          ? undefined
          : current.tokenRenewErrorMessage,
        quotaInfo,
        quotaLoading: false,
        quotaErrorMessage: quotaInfo.unavailableReason?.message,
        tokenRefreshInProgress: false,
        updatedAt: Date.now(),
      })
    } catch (error) {
      this.states.set(profileId, {
        ...current,
        profileId,
        authAvailable: true,
        authErrorMessage: undefined,
        tokenStatus: getTokenStatus(authData),
        refreshTokenStatus: getRefreshTokenStatus(authData),
        lastRenewedAt: getLastRefreshTimestamp(authData),
        quotaInfo: null,
        quotaLoading: false,
        quotaErrorMessage:
          error instanceof Error && error.message
            ? error.message
            : 'Quota unavailable',
        tokenRefreshInProgress: false,
        updatedAt: Date.now(),
      })
    }

    this.onDidChangeStateEmitter.fire(profileId)
  }

  private async doRefreshToken(
    profileId: string,
    options?: RefreshTokenOptions,
  ): Promise<boolean> {
    const automatic = Boolean(options?.automatic)
    const current =
      this.states.get(profileId) || this.createBaseState(profileId)
    this.states.set(profileId, {
      ...current,
      tokenRefreshInProgress: true,
      tokenRenewErrorMessage: undefined,
    })
    this.onDidChangeStateEmitter.fire(profileId)

    const leased = await this.profileManager.withProfileRenewLease(
      profileId,
      async () => {
        const authData = await this.profileManager.loadAuthData(profileId)
        if (!authData) {
          return {
            skipped: false,
            success: false,
            errorMessage: 'Stored auth unavailable',
          }
        }

        if (
          automatic &&
          !isTokenRenewDue(authData, this.getTokenAutoRenewIntervalMinutes())
        ) {
          return {
            skipped: true,
            success: true,
            authData,
          }
        }

        try {
          const payload = await refreshAccessTokenPayload(
            buildAuthPayload(authData),
          )
          const nextAuthData = authDataFromPayload(payload, authData)
          await this.persistAuthIfChanged(profileId, authData, nextAuthData)

          return {
            skipped: false,
            success: true,
            authData: nextAuthData,
          }
        } catch (error) {
          return {
            skipped: false,
            success: false,
            authData,
            errorMessage:
              error instanceof Error && error.message
                ? error.message
                : 'Token renewal failed',
          }
        }
      },
    )

    if (!leased.acquired) {
      this.states.set(profileId, {
        ...current,
        profileId,
        tokenRefreshInProgress: false,
        tokenRenewErrorMessage: automatic
          ? undefined
          : vscode.l10n.t(
              'Token renewal is already running on another client.',
            ),
      })
      this.onDidChangeStateEmitter.fire(profileId)
      return automatic
    }

    const result = leased.value
    if (!result || !result.success || !result.authData) {
      this.states.set(profileId, {
        ...current,
        profileId,
        authAvailable: Boolean(result?.authData),
        authErrorMessage:
          result?.errorMessage === 'Stored auth unavailable'
            ? result.errorMessage
            : undefined,
        tokenStatus: result?.authData
          ? getTokenStatus(result.authData)
          : current.tokenStatus,
        refreshTokenStatus: result?.authData
          ? getRefreshTokenStatus(result.authData)
          : current.refreshTokenStatus,
        lastRenewedAt: result?.authData
          ? getLastRefreshTimestamp(result.authData)
          : current.lastRenewedAt,
        tokenRefreshInProgress: false,
        tokenRenewErrorMessage: result?.errorMessage || 'Token renewal failed',
        updatedAt: Date.now(),
      })
      this.onDidChangeStateEmitter.fire(profileId)
      return false
    }

    const nextAuthData = result.authData
    this.states.set(profileId, {
      ...current,
      profileId,
      authAvailable: true,
      authErrorMessage: undefined,
      tokenStatus: getTokenStatus(nextAuthData),
      refreshTokenStatus: getRefreshTokenStatus(nextAuthData),
      lastRenewedAt: getLastRefreshTimestamp(nextAuthData),
      tokenRefreshInProgress: false,
      tokenRenewErrorMessage: undefined,
      updatedAt: Date.now(),
    })
    this.onDidChangeStateEmitter.fire(profileId)
    return true
  }

  private async updateLocalState(
    profileId: string,
    emit = true,
  ): Promise<void> {
    const previous =
      this.states.get(profileId) || this.createBaseState(profileId)
    const authData = await this.profileManager.loadAuthData(profileId)

    if (!authData) {
      this.states.set(profileId, {
        ...this.createBaseState(profileId),
        profileId,
        authAvailable: false,
        authErrorMessage: 'Stored auth unavailable',
      })
      if (emit) {
        this.onDidChangeStateEmitter.fire(profileId)
      }
      return
    }

    const nextLastRenewedAt = getLastRefreshTimestamp(authData)
    this.states.set(profileId, {
      ...previous,
      profileId,
      authAvailable: true,
      authErrorMessage: undefined,
      tokenStatus: getTokenStatus(authData),
      refreshTokenStatus: getRefreshTokenStatus(authData),
      lastRenewedAt: nextLastRenewedAt,
      tokenRenewErrorMessage:
        nextLastRenewedAt && nextLastRenewedAt !== previous.lastRenewedAt
          ? undefined
          : previous.tokenRenewErrorMessage,
    })
    if (emit) {
      this.onDidChangeStateEmitter.fire(profileId)
    }
  }

  private async persistAuthIfChanged(
    profileId: string,
    previousAuth: Pick<
      AuthData,
      'idToken' | 'accessToken' | 'refreshToken' | 'authJson'
    >,
    nextAuth: Pick<
      AuthData,
      'idToken' | 'accessToken' | 'refreshToken' | 'authJson'
    > &
      Parameters<ProfileManager['updateStoredProfileAuth']>[1],
  ): Promise<void> {
    if (sameAuth(previousAuth, nextAuth)) {
      return
    }

    await this.profileManager.updateStoredProfileAuth(profileId, nextAuth, {
      syncIfActive: true,
    })
  }

  private createBaseState(profileId: string): ProfileHealthState {
    return {
      profileId,
      authAvailable: false,
      authErrorMessage: undefined,
      tokenStatus: null,
      refreshTokenStatus: createDefaultRefreshTokenStatus(),
      lastRenewedAt: null,
      tokenRenewErrorMessage: undefined,
      quotaInfo: null,
      quotaLoading: false,
      quotaErrorMessage: undefined,
      tokenRefreshInProgress: false,
      updatedAt: null,
    }
  }

  private restartQuotaTimer(): void {
    if (this.quotaTimer) {
      clearInterval(this.quotaTimer)
      this.quotaTimer = undefined
    }

    const intervalSeconds = vscode.workspace
      .getConfiguration('codexSwitch')
      .get<number>('quotaRefreshInterval', QUOTA_REFRESH_DEFAULT_SECONDS)

    if (!intervalSeconds || intervalSeconds < 1) {
      return
    }

    this.quotaTimer = setInterval(() => {
      void this.refreshAllQuotas()
    }, intervalSeconds * 1000)
  }

  private restartTokenRenewTimer(): void {
    if (this.tokenRenewTimer) {
      clearInterval(this.tokenRenewTimer)
      this.tokenRenewTimer = undefined
    }

    if (!this.isTokenAutoRenewEnabled()) {
      return
    }

    this.tokenRenewTimer = setInterval(
      () => {
        void this.refreshDueTokens()
      },
      this.getTokenAutoRenewIntervalMinutes() * 60 * 1000,
    )
  }

  private scheduleDeferredTokenRenewSweep(): void {
    if (this.startupTokenRenewTimer) {
      clearTimeout(this.startupTokenRenewTimer)
      this.startupTokenRenewTimer = undefined
    }

    if (!this.isTokenAutoRenewEnabled()) {
      return
    }

    this.startupTokenRenewTimer = setTimeout(() => {
      this.startupTokenRenewTimer = undefined
      void this.refreshDueTokens()
    }, STARTUP_TOKEN_RENEW_DELAY_MS)
    this.startupTokenRenewTimer.unref?.()
  }

  private isTokenAutoRenewEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('codexSwitch')
      .get<boolean>('autoRenewTokens', true)
  }

  private getTokenAutoRenewIntervalMinutes(): number {
    const raw = vscode.workspace
      .getConfiguration('codexSwitch')
      .get<number>(
        'tokenAutoRenewIntervalMinutes',
        TOKEN_AUTO_RENEW_DEFAULT_MINUTES,
      )

    if (!raw || !Number.isFinite(raw)) {
      return TOKEN_AUTO_RENEW_DEFAULT_MINUTES
    }

    return Math.max(TOKEN_AUTO_RENEW_MINIMUM_MINUTES, Math.floor(raw))
  }
}
