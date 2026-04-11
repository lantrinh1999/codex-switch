import * as vscode from 'vscode'
import { ProfileManager } from '../auth/profile-manager'
import {
  ProfileHealthState,
  ProfileSummary,
  RefreshTokenStatus,
} from '../types'
import {
  authDataFromPayload,
  buildAuthPayload,
  fetchQuotaInfo,
  getRefreshTokenStatus,
  getTokenStatus,
  refreshAccessTokenPayload,
} from './profile-health'

function createDefaultRefreshTokenStatus(): RefreshTokenStatus {
  return {
    available: false,
    label: 'missing',
  }
}

function sameAuth(
  left: { idToken: string; accessToken: string; refreshToken: string },
  right: { idToken: string; accessToken: string; refreshToken: string },
): boolean {
  return (
    left.idToken === right.idToken &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken
  )
}

export class ProfileHealthService implements vscode.Disposable {
  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<
    string | undefined
  >()

  readonly onDidChangeState = this.onDidChangeStateEmitter.event

  private readonly states = new Map<string, ProfileHealthState>()
  private readonly quotaRefreshes = new Map<string, Promise<void>>()
  private readonly tokenRefreshes = new Map<string, Promise<boolean>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly configurationListener: vscode.Disposable

  constructor(private readonly profileManager: ProfileManager) {
    this.restartTimer()
    this.configurationListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration('codexSwitch.quotaRefreshInterval')) {
          this.restartTimer()
        }
      },
    )
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
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

  async refreshToken(profileId: string): Promise<boolean> {
    const existing = this.tokenRefreshes.get(profileId)
    if (existing) {
      return existing
    }

    const promise = this.doRefreshToken(profileId).finally(() => {
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

      this.states.set(profileId, {
        profileId,
        authAvailable: true,
        tokenStatus: getTokenStatus(nextAuthData),
        refreshTokenStatus: getRefreshTokenStatus(nextAuthData),
        quotaInfo,
        quotaLoading: false,
        quotaErrorMessage: quotaInfo.unavailableReason?.message,
        tokenRefreshInProgress: false,
        updatedAt: Date.now(),
      })
    } catch (error) {
      this.states.set(profileId, {
        ...this.createBaseState(profileId),
        authAvailable: true,
        tokenStatus: getTokenStatus(authData),
        refreshTokenStatus: getRefreshTokenStatus(authData),
        quotaInfo: null,
        quotaLoading: false,
        quotaErrorMessage:
          error instanceof Error && error.message
            ? error.message
            : 'Quota unavailable',
        updatedAt: Date.now(),
      })
    }

    this.onDidChangeStateEmitter.fire(profileId)
  }

  private async doRefreshToken(profileId: string): Promise<boolean> {
    const current =
      this.states.get(profileId) || this.createBaseState(profileId)
    this.states.set(profileId, {
      ...current,
      tokenRefreshInProgress: true,
      quotaErrorMessage: undefined,
    })
    this.onDidChangeStateEmitter.fire(profileId)

    const authData = await this.profileManager.loadAuthData(profileId)
    if (!authData) {
      this.states.set(profileId, {
        ...this.createBaseState(profileId),
        authAvailable: false,
        authErrorMessage: 'Stored auth unavailable',
        tokenRefreshInProgress: false,
      })
      this.onDidChangeStateEmitter.fire(profileId)
      return false
    }

    try {
      const payload = await refreshAccessTokenPayload(
        buildAuthPayload(authData),
      )
      const nextAuthData = authDataFromPayload(payload, authData)
      await this.persistAuthIfChanged(profileId, authData, nextAuthData)

      this.states.set(profileId, {
        ...(this.states.get(profileId) || this.createBaseState(profileId)),
        profileId,
        authAvailable: true,
        authErrorMessage: undefined,
        tokenStatus: getTokenStatus(nextAuthData),
        refreshTokenStatus: getRefreshTokenStatus(nextAuthData),
        tokenRefreshInProgress: false,
        updatedAt: Date.now(),
      })
      this.onDidChangeStateEmitter.fire(profileId)
      return true
    } catch (error) {
      this.states.set(profileId, {
        ...(this.states.get(profileId) || this.createBaseState(profileId)),
        profileId,
        authAvailable: true,
        authErrorMessage:
          error instanceof Error && error.message
            ? error.message
            : 'Token refresh failed',
        tokenStatus: getTokenStatus(authData),
        refreshTokenStatus: getRefreshTokenStatus(authData),
        tokenRefreshInProgress: false,
      })
      this.onDidChangeStateEmitter.fire(profileId)
      return false
    }
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
        ...previous,
        profileId,
        authAvailable: false,
        authErrorMessage: 'Stored auth unavailable',
        tokenStatus: null,
        refreshTokenStatus: createDefaultRefreshTokenStatus(),
        quotaInfo: null,
        quotaLoading: false,
        tokenRefreshInProgress: false,
      })
      if (emit) {
        this.onDidChangeStateEmitter.fire(profileId)
      }
      return
    }

    this.states.set(profileId, {
      ...previous,
      profileId,
      authAvailable: true,
      authErrorMessage: undefined,
      tokenStatus: getTokenStatus(authData),
      refreshTokenStatus: getRefreshTokenStatus(authData),
    })
    if (emit) {
      this.onDidChangeStateEmitter.fire(profileId)
    }
  }

  private async persistAuthIfChanged(
    profileId: string,
    previousAuth: {
      idToken: string
      accessToken: string
      refreshToken: string
    },
    nextAuth: {
      idToken: string
      accessToken: string
      refreshToken: string
    } & Parameters<ProfileManager['updateStoredProfileAuth']>[1],
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
      quotaInfo: null,
      quotaLoading: false,
      quotaErrorMessage: undefined,
      tokenRefreshInProgress: false,
      updatedAt: null,
    }
  }

  private restartTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }

    const intervalSeconds = vscode.workspace
      .getConfiguration('codexSwitch')
      .get<number>('quotaRefreshInterval', 300)

    if (!intervalSeconds || intervalSeconds < 1) {
      return
    }

    this.timer = setInterval(() => {
      void this.refreshAllQuotas()
    }, intervalSeconds * 1000)
  }
}
