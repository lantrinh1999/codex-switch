import * as vscode from 'vscode'
import { ProfileHealthState, ProfileSummary, RuntimeSession } from '../types'
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
  runtimeSession: RuntimeSession | null,
  profiles: ProfileSummary[],
  healthState?: ProfileHealthState,
) {
  if (!statusBarItem) {
    return
  }

  cachedProfiles = profiles || []

  if (!runtimeSession || runtimeSession.kind === 'noAuth') {
    statusBarItem.text = `$(account) ${vscode.l10n.t('Codex: {0}', vscode.l10n.t('none'))}`
    statusBarItem.command = 'codex-switch.profile.manage'
    statusBarItem.tooltip = createProfileTooltip(runtimeSession, cachedProfiles)
    return
  }

  if (runtimeSession.kind === 'externalAuth') {
    const plan =
      runtimeSession.authData?.planType &&
      runtimeSession.authData.planType !== 'Unknown'
        ? runtimeSession.authData.planType
        : vscode.l10n.t('external')
    statusBarItem.text = `$(account) ${vscode.l10n.t('Codex: {0}', vscode.l10n.t('External'))} · ${plan}`
    statusBarItem.command = 'codex-switch.profile.manage'
    statusBarItem.tooltip = createProfileTooltip(runtimeSession, cachedProfiles)
    return
  }

  const activeProfile =
    cachedProfiles.find(
      (profile) => profile.id === runtimeSession.matchedProfileId,
    ) || null
  if (!activeProfile) {
    statusBarItem.text = `$(account) ${vscode.l10n.t('Codex: {0}', vscode.l10n.t('none'))}`
    statusBarItem.command = 'codex-switch.profile.manage'
    statusBarItem.tooltip = createProfileTooltip(runtimeSession, cachedProfiles)
    return
  }

  const quotaSummary = formatQuotaSummary(healthState?.quotaInfo || null)
  statusBarItem.text = quotaSummary
    ? `$(account) ${vscode.l10n.t('Codex: {0}', activeProfile.name)} · ${quotaSummary}`
    : `$(account) ${vscode.l10n.t('Codex: {0}', activeProfile.name)}`
  statusBarItem.command =
    cachedProfiles.length <= 1
      ? 'codex-switch.profile.manage'
      : 'codex-switch.profile.statusBarAction'
  statusBarItem.tooltip = createProfileTooltip(runtimeSession, cachedProfiles)
}

export function getStatusBarItem(): vscode.StatusBarItem {
  return statusBarItem
}
