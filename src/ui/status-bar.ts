import * as vscode from 'vscode'
import { ProfileHealthState, ProfileSummary } from '../types'
import { formatQuotaSummary } from '../health/profile-health'
import { createProfileTooltip } from './tooltip-builder'

let statusBarItem: vscode.StatusBarItem
let cachedProfiles: ProfileSummary[] = []

export function createStatusBarItem(): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(
    'codex-switch.profile',
    vscode.StatusBarAlignment.Right,
    100,
  )

  updateProfileStatus(null, [])
  statusBarItem.show()
  return statusBarItem
}

export function updateProfileStatus(
  profile: ProfileSummary | null,
  profiles: ProfileSummary[],
  healthState?: ProfileHealthState,
) {
  if (!statusBarItem) {
    return
  }

  cachedProfiles = profiles || []

  if (!profile) {
    statusBarItem.text = `$(account) ${vscode.l10n.t('Codex: {0}', vscode.l10n.t('none'))}`
    statusBarItem.command = 'codex-switch.profile.manage'
    statusBarItem.tooltip = createProfileTooltip(null, cachedProfiles)
    return
  }

  const quotaSummary = formatQuotaSummary(healthState?.quotaInfo || null)
  statusBarItem.text = quotaSummary
    ? `$(account) ${vscode.l10n.t('Codex: {0}', profile.name)} · ${quotaSummary}`
    : `$(account) ${vscode.l10n.t('Codex: {0}', profile.name)}`
  // If there is nothing meaningful to switch to, go straight to Manage.
  statusBarItem.command =
    cachedProfiles.length <= 1
      ? 'codex-switch.profile.manage'
      : 'codex-switch.profile.statusBarAction'
  statusBarItem.tooltip = createProfileTooltip(profile, cachedProfiles)
}

export function getStatusBarItem(): vscode.StatusBarItem {
  return statusBarItem
}
