import * as vscode from 'vscode'
import { ProfileHealthState, ProfileSummary, RuntimeSession } from '../types'
import { formatQuotaSummary } from '../health/profile-health'
import { createProfileTooltip } from './tooltip-builder'
import { getRuntimePrimaryLabel } from '../profile-labels'

let statusBarItem: vscode.StatusBarItem
let cachedProfiles: ProfileSummary[] = []

function getStatusBarCommand(
  runtimeSession: RuntimeSession | null,
  profiles: ProfileSummary[],
  activeProfile?: ProfileSummary | null,
): string {
  if (profiles.length === 0) {
    return 'codex-switch.profile.manage'
  }

  if (
    runtimeSession?.kind === 'matchedProfile' &&
    activeProfile &&
    profiles.length <= 1
  ) {
    return 'codex-switch.profile.manage'
  }

  return 'codex-switch.profile.statusBarAction'
}

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
    statusBarItem.command = getStatusBarCommand(runtimeSession, cachedProfiles)
    statusBarItem.tooltip = createProfileTooltip(runtimeSession, cachedProfiles)
    return
  }

  if (runtimeSession.kind === 'externalAuth') {
    const runtimeLabel = getRuntimePrimaryLabel(runtimeSession)
    statusBarItem.text = `$(account) ${vscode.l10n.t('Codex: {0}', runtimeLabel)} · ${vscode.l10n.t('External')}`
    statusBarItem.command = getStatusBarCommand(runtimeSession, cachedProfiles)
    statusBarItem.tooltip = createProfileTooltip(runtimeSession, cachedProfiles)
    return
  }

  const activeProfile =
    cachedProfiles.find(
      (profile) => profile.id === runtimeSession.matchedProfileId,
    ) || null
  if (!activeProfile) {
    statusBarItem.text = `$(account) ${vscode.l10n.t(
      'Codex: {0}',
      getRuntimePrimaryLabel(runtimeSession),
    )}`
    statusBarItem.command = getStatusBarCommand(runtimeSession, cachedProfiles)
    statusBarItem.tooltip = createProfileTooltip(runtimeSession, cachedProfiles)
    return
  }

  const quotaSummary = formatQuotaSummary(healthState?.quotaInfo || null)
  const runtimeLabel = getRuntimePrimaryLabel(runtimeSession, activeProfile)
  statusBarItem.text = quotaSummary
    ? `$(account) ${vscode.l10n.t('Codex: {0}', runtimeLabel)} · ${quotaSummary}`
    : `$(account) ${vscode.l10n.t('Codex: {0}', runtimeLabel)}`
  statusBarItem.command = getStatusBarCommand(
    runtimeSession,
    cachedProfiles,
    activeProfile,
  )
  statusBarItem.tooltip = createProfileTooltip(runtimeSession, cachedProfiles)
}

export function getStatusBarItem(): vscode.StatusBarItem {
  return statusBarItem
}
