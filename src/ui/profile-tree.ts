import * as vscode from 'vscode'
import { ProfileHealthState, ProfileSummary, QuotaWindowInfo } from '../types'
import {
  formatQuotaSummary,
  formatQuotaWindowDescription,
  getQuotaWindowLabel,
} from '../health/profile-health'

function getLastRenewedLabel(
  healthState: ProfileHealthState | undefined,
): string | undefined {
  if (!healthState) {
    return undefined
  }

  if (healthState.tokenRefreshInProgress) {
    return vscode.l10n.t('Renewing')
  }

  if (healthState.lastRenewedAt) {
    return healthState.lastRenewedAt
  }

  return healthState.refreshTokenStatus.available
    ? vscode.l10n.t('Never')
    : vscode.l10n.t('Unavailable')
}

function quotaIcon(window: QuotaWindowInfo): vscode.ThemeIcon {
  if (window.remainingPercent === 0) {
    return new vscode.ThemeIcon(
      'error',
      new vscode.ThemeColor('errorForeground'),
    )
  }
  if (window.usedPercent >= 70) {
    return new vscode.ThemeIcon(
      'warning',
      new vscode.ThemeColor('errorForeground'),
    )
  }
  if (window.usedPercent >= 50) {
    return new vscode.ThemeIcon(
      'info',
      new vscode.ThemeColor('editorWarning.foreground'),
    )
  }
  return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
}

function getWorkspaceLabel(profile: ProfileSummary): string | null {
  if (
    profile.defaultOrganizationTitle &&
    profile.defaultOrganizationTitle.trim()
  ) {
    return profile.defaultOrganizationTitle.trim()
  }
  if (profile.defaultOrganizationId && profile.defaultOrganizationId.trim()) {
    return profile.defaultOrganizationId.trim()
  }
  return null
}

function buildRootDescription(
  profile: ProfileSummary,
  healthState: ProfileHealthState | undefined,
): string | undefined {
  if (healthState?.tokenRefreshInProgress) {
    return vscode.l10n.t('Renewing token')
  }

  // Keep collapsed rows stable even after a failed renewal attempt. The
  // failure remains visible in the tooltip and expanded detail rows, while the
  // root row continues to show the usual quota/token summary the user expects.
  const quotaSummary = formatQuotaSummary(healthState?.quotaInfo || null)
  if (quotaSummary) {
    return quotaSummary
  }

  const parts: string[] = []
  if (profile.planType && profile.planType !== 'Unknown') {
    parts.push(profile.planType)
  }

  if (healthState?.quotaLoading) {
    parts.push(vscode.l10n.t('Refreshing quota'))
  } else if (healthState?.quotaErrorMessage) {
    parts.push(healthState.quotaErrorMessage)
  } else if (healthState?.tokenStatus) {
    parts.push(healthState.tokenStatus.label)
  } else if (healthState && !healthState.authAvailable) {
    parts.push(
      healthState.authErrorMessage || vscode.l10n.t('Stored auth unavailable'),
    )
  }

  return parts.length > 0 ? parts.join(' · ') : undefined
}

function buildRootTooltip(
  profile: ProfileSummary,
  isActive: boolean,
  healthState: ProfileHealthState | undefined,
): string {
  const lines = [
    `${vscode.l10n.t('Profile')}: ${profile.name}`,
    `${vscode.l10n.t('Email')}: ${
      profile.email && profile.email !== 'Unknown'
        ? profile.email
        : vscode.l10n.t('Unknown')
    }`,
    `${vscode.l10n.t('Plan')}: ${profile.planType || vscode.l10n.t('Unknown')}`,
  ]

  const workspace = getWorkspaceLabel(profile)
  if (workspace) {
    lines.push(`${vscode.l10n.t('Workspace')}: ${workspace}`)
  }
  if (isActive) {
    lines.push(vscode.l10n.t('Active'))
  }
  if (healthState?.tokenStatus) {
    lines.push(`${vscode.l10n.t('Token')}: ${healthState.tokenStatus.label}`)
  }
  lines.push(
    `${vscode.l10n.t('Refresh token')}: ${
      healthState?.refreshTokenStatus.label || vscode.l10n.t('missing')
    }`,
  )
  const lastRenewedLabel = getLastRenewedLabel(healthState)
  if (lastRenewedLabel) {
    lines.push(`${vscode.l10n.t('Last renewed')}: ${lastRenewedLabel}`)
  }
  if (healthState?.tokenRenewErrorMessage) {
    lines.push(
      `${vscode.l10n.t('Token renewal')}: ${healthState.tokenRenewErrorMessage}`,
    )
  }

  const quotaSummary = formatQuotaSummary(healthState?.quotaInfo || null)
  if (quotaSummary) {
    lines.push(`${vscode.l10n.t('Quota')}: ${quotaSummary}`)
  } else if (healthState?.quotaLoading) {
    lines.push(`${vscode.l10n.t('Quota')}: ${vscode.l10n.t('Refreshing')}`)
  } else if (healthState?.quotaInfo?.unavailableReason) {
    lines.push(
      `${vscode.l10n.t('Quota')}: ${healthState.quotaInfo.unavailableReason.message}`,
    )
  } else if (healthState?.quotaErrorMessage) {
    lines.push(`${vscode.l10n.t('Quota')}: ${healthState.quotaErrorMessage}`)
  }

  return lines.join('\n')
}

function getRootIcon(
  isActive: boolean,
  healthState: ProfileHealthState | undefined,
): vscode.ThemeIcon {
  if (healthState && !healthState.authAvailable) {
    return new vscode.ThemeIcon(
      'warning',
      new vscode.ThemeColor('errorForeground'),
    )
  }
  if (healthState?.quotaErrorMessage && !healthState.quotaInfo) {
    return new vscode.ThemeIcon(
      'warning',
      new vscode.ThemeColor('errorForeground'),
    )
  }
  if (isActive) {
    return new vscode.ThemeIcon(
      'pass-filled',
      new vscode.ThemeColor('charts.green'),
    )
  }
  return new vscode.ThemeIcon('account')
}

export type ProfileTreeNode = ProfileTreeItem | ProfileDetailItem

export class ProfileDetailItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string | undefined,
    tooltip: string | undefined,
    public readonly profileId: string,
    public readonly parent?: ProfileTreeItem,
    public readonly rawValue?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.description = description
    this.tooltip = tooltip
    this.contextValue = rawValue ? 'profileCopyableField' : 'profileDetail'
  }
}

export class ProfileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly profile: ProfileSummary,
    public readonly healthState: ProfileHealthState | undefined,
    public readonly isActive: boolean,
    isExpanded: boolean,
  ) {
    super(
      profile.name,
      isExpanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    )
    this.description = buildRootDescription(profile, healthState)
    this.tooltip = buildRootTooltip(profile, isActive, healthState)
    this.contextValue = 'profileItem'
    this.iconPath = getRootIcon(isActive, healthState)
  }
}

export class ProfileTreeProvider
  implements vscode.TreeDataProvider<ProfileTreeNode>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    ProfileTreeNode | undefined
  >()

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event

  private profiles: ProfileSummary[] = []
  private activeProfileId: string | undefined
  private healthStates = new Map<string, ProfileHealthState>()
  private rootItems: ProfileTreeItem[] = []
  private expandedProfileIds = new Set<string>()

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose()
  }

  setState(
    profiles: ProfileSummary[],
    activeProfileId: string | undefined,
    healthStates: ReadonlyMap<string, ProfileHealthState>,
  ): void {
    this.profiles = profiles
    this.activeProfileId = activeProfileId
    this.healthStates = new Map(healthStates)
    const visibleProfileIds = new Set(this.profiles.map((profile) => profile.id))
    this.expandedProfileIds = new Set(
      [...this.expandedProfileIds].filter((profileId) =>
        visibleProfileIds.has(profileId),
      ),
    )
    this.rootItems = this.profiles.map(
      (profile) =>
        new ProfileTreeItem(
          profile,
          this.healthStates.get(profile.id),
          profile.id === this.activeProfileId,
          this.expandedProfileIds.has(profile.id),
        ),
    )
    this.onDidChangeTreeDataEmitter.fire(undefined)
  }

  setExpanded(profileId: string, expanded: boolean): void {
    if (expanded) {
      this.expandedProfileIds.add(profileId)
      return
    }
    this.expandedProfileIds.delete(profileId)
  }

  expandAll(): void {
    for (const item of this.rootItems) {
      this.expandedProfileIds.add(item.profile.id)
    }
  }

  getTreeItem(element: ProfileTreeNode): vscode.TreeItem {
    return element
  }

  getChildren(element?: ProfileTreeNode): ProfileTreeNode[] {
    if (!element) {
      return this.getRootItems()
    }

    if (element instanceof ProfileDetailItem) {
      return []
    }

    return this.buildProfileDetails(element)
  }

  getRootItems(): ProfileTreeItem[] {
    return this.rootItems
  }

  getParent(element: ProfileTreeNode): ProfileTreeNode | undefined {
    if (element instanceof ProfileDetailItem) {
      return element.parent
    }
    return undefined
  }

  private buildProfileDetails(parent: ProfileTreeItem): ProfileDetailItem[] {
    const items: ProfileDetailItem[] = []
    const { profile, healthState } = parent
    const email =
      profile.email && profile.email !== 'Unknown'
        ? profile.email
        : vscode.l10n.t('Unknown')

    const emailItem = new ProfileDetailItem(
      vscode.l10n.t('Email'),
      email,
      email,
      profile.id,
      parent,
      email !== vscode.l10n.t('Unknown') ? email : undefined,
    )
    emailItem.iconPath = new vscode.ThemeIcon('mail')
    items.push(emailItem)

    const planItem = new ProfileDetailItem(
      vscode.l10n.t('Plan'),
      profile.planType || vscode.l10n.t('Unknown'),
      profile.planType || vscode.l10n.t('Unknown'),
      profile.id,
      parent,
    )
    planItem.iconPath = new vscode.ThemeIcon('tag')
    items.push(planItem)

    const workspace = getWorkspaceLabel(profile)
    if (workspace) {
      const workspaceItem = new ProfileDetailItem(
        vscode.l10n.t('Workspace'),
        workspace,
        profile.defaultOrganizationId &&
          profile.defaultOrganizationTitle &&
          profile.defaultOrganizationId !== profile.defaultOrganizationTitle
          ? `${profile.defaultOrganizationTitle} (${profile.defaultOrganizationId})`
          : workspace,
        profile.id,
        parent,
      )
      workspaceItem.iconPath = new vscode.ThemeIcon('organization')
      items.push(workspaceItem)
    }

    if (!healthState || !healthState.authAvailable) {
      const unavailableItem = new ProfileDetailItem(
        vscode.l10n.t('Status'),
        healthState?.authErrorMessage ||
          vscode.l10n.t('Stored auth unavailable'),
        healthState?.authErrorMessage ||
          vscode.l10n.t('Stored auth unavailable'),
        profile.id,
        parent,
      )
      unavailableItem.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('errorForeground'),
      )
      items.push(unavailableItem)
      return items
    }

    const tokenItem = new ProfileDetailItem(
      vscode.l10n.t('Token'),
      healthState.tokenStatus?.label || vscode.l10n.t('unknown'),
      healthState.tokenStatus?.label || vscode.l10n.t('unknown'),
      profile.id,
      parent,
    )
    tokenItem.iconPath = healthState.tokenStatus?.isExpired
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
      : new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'))
    items.push(tokenItem)

    const refreshTokenItem = new ProfileDetailItem(
      vscode.l10n.t('Refresh token'),
      healthState.tokenRefreshInProgress
        ? vscode.l10n.t('Renewing')
        : healthState.refreshTokenStatus.label,
      healthState.tokenRefreshInProgress
        ? vscode.l10n.t('Renewing')
        : healthState.refreshTokenStatus.label,
      profile.id,
      parent,
    )
    refreshTokenItem.iconPath = healthState.tokenRefreshInProgress
      ? new vscode.ThemeIcon('loading~spin')
      : healthState.refreshTokenStatus.available
        ? new vscode.ThemeIcon('refresh', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('circle-slash')
    items.push(refreshTokenItem)

    const lastRenewedLabel = getLastRenewedLabel(healthState)
    if (lastRenewedLabel) {
      const lastRenewedItem = new ProfileDetailItem(
        vscode.l10n.t('Last renewed'),
        lastRenewedLabel,
        lastRenewedLabel,
        profile.id,
        parent,
      )
      lastRenewedItem.iconPath = healthState.tokenRefreshInProgress
        ? new vscode.ThemeIcon('loading~spin')
        : lastRenewedLabel === vscode.l10n.t('Unavailable')
          ? new vscode.ThemeIcon('circle-slash')
          : new vscode.ThemeIcon(
              'history',
              new vscode.ThemeColor('charts.green'),
            )
      items.push(lastRenewedItem)
    }

    if (healthState.tokenRenewErrorMessage) {
      const renewalErrorItem = new ProfileDetailItem(
        vscode.l10n.t('Token renewal'),
        healthState.tokenRenewErrorMessage,
        healthState.tokenRenewErrorMessage,
        profile.id,
        parent,
      )
      renewalErrorItem.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('errorForeground'),
      )
      items.push(renewalErrorItem)
    }

    if (healthState.quotaLoading) {
      const loadingItem = new ProfileDetailItem(
        vscode.l10n.t('Quota'),
        vscode.l10n.t('Refreshing'),
        vscode.l10n.t('Fetching quota information'),
        profile.id,
        parent,
      )
      loadingItem.iconPath = new vscode.ThemeIcon('loading~spin')
      items.push(loadingItem)
      return items
    }

    if (healthState.quotaInfo?.unavailableReason) {
      const unavailableItem = new ProfileDetailItem(
        vscode.l10n.t('Quota'),
        healthState.quotaInfo.unavailableReason.message,
        healthState.quotaInfo.unavailableReason.message,
        profile.id,
        parent,
      )
      unavailableItem.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('errorForeground'),
      )
      items.push(unavailableItem)
      return items
    }

    if (!healthState.quotaInfo) {
      const emptyItem = new ProfileDetailItem(
        vscode.l10n.t('Quota'),
        healthState.quotaErrorMessage || vscode.l10n.t('No data'),
        healthState.quotaErrorMessage || vscode.l10n.t('No data'),
        profile.id,
        parent,
      )
      emptyItem.iconPath = new vscode.ThemeIcon('circle-slash')
      items.push(emptyItem)
      return items
    }

    if (healthState.quotaInfo.primaryWindow) {
      const primary = healthState.quotaInfo.primaryWindow
      const primaryItem = new ProfileDetailItem(
        vscode.l10n.t('{0} quota', getQuotaWindowLabel(primary)),
        formatQuotaWindowDescription(primary),
        formatQuotaWindowDescription(primary),
        profile.id,
        parent,
      )
      primaryItem.iconPath = quotaIcon(primary)
      items.push(primaryItem)
    }

    if (healthState.quotaInfo.secondaryWindow) {
      const secondary = healthState.quotaInfo.secondaryWindow
      const secondaryItem = new ProfileDetailItem(
        vscode.l10n.t('{0} quota', getQuotaWindowLabel(secondary)),
        formatQuotaWindowDescription(secondary),
        formatQuotaWindowDescription(secondary),
        profile.id,
        parent,
      )
      secondaryItem.iconPath = quotaIcon(secondary)
      items.push(secondaryItem)
    }

    return items
  }
}
