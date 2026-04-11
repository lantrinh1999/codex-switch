import { ProfileHealthService } from '../health/profile-health-service'

export class RefreshCoordinator {
  private inflightUiRefresh: Promise<void> | undefined

  constructor(
    private readonly refreshUiFn: () => Promise<void>,
    private readonly healthService: ProfileHealthService,
  ) {}

  getHealthStates() {
    return this.healthService.getStates()
  }

  async refreshUi(): Promise<void> {
    if (!this.inflightUiRefresh) {
      this.inflightUiRefresh = (async () => {
        try {
          await this.refreshUiFn()
        } finally {
          this.inflightUiRefresh = undefined
        }
      })()
    }

    await this.inflightUiRefresh
  }

  async refreshAll(): Promise<void> {
    await this.refreshUi()
    await this.healthService.refreshAll()
  }

  async refreshQuota(profileId?: string): Promise<void> {
    // Optimization note [2026-04-12 04:42 ICT]:
    // Quota refresh already works from known profile ids or cached state.
    // Skipping the extra full UI refresh here avoids duplicate tree rebuilds
    // and repeated SecretStorage reads before every quota request.
    if (profileId) {
      await this.healthService.refreshQuota(profileId)
      return
    }

    await this.healthService.refreshAllQuotas()
  }

  async refreshToken(profileId: string): Promise<boolean> {
    // Optimization note [2026-04-12 04:42 ICT]:
    // Token refresh targets one known profile and updates health state itself.
    // Avoid forcing a whole UI sync first so status-bar/sidebar actions stay
    // responsive even when multiple profiles are stored.
    return this.healthService.refreshToken(profileId)
  }
}
