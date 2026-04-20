import * as vscode from 'vscode'
import { ProfileSummary, RuntimeSession } from '../types'
import {
  getProfileAlias,
  getProfileFullEmail,
  getProfilePrimaryLabel,
  getRuntimeAlias,
  getRuntimePrimaryLabel,
} from '../profile-labels'
import { escapeMarkdown } from '../utils/markdown'

function buildCommandUri(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`
}

function escapeLinkTitle(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function createProfileTooltip(
  runtimeSession: RuntimeSession | null,
  profiles: ProfileSummary[],
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString()
  tooltip.supportThemeIcons = true
  tooltip.supportHtml = true
  tooltip.isTrusted = {
    enabledCommands: [
      'codex-switch.profile.manage',
      'codex-switch.profile.activate',
    ],
  }

  tooltip.appendMarkdown(`${vscode.l10n.t('Codex accounts')}\n\n`)

  if (!runtimeSession || runtimeSession.kind === 'noAuth') {
    tooltip.appendMarkdown(
      `${vscode.l10n.t('Runtime auth')}: ${vscode.l10n.t('none')}\n\n`,
    )
  } else if (runtimeSession.kind === 'externalAuth') {
    const runtimeLabel = getRuntimePrimaryLabel(runtimeSession)
    const email = runtimeSession.authData?.email || vscode.l10n.t('Unknown')
    const plan =
      runtimeSession.authData?.planType &&
      runtimeSession.authData.planType !== 'Unknown'
        ? runtimeSession.authData.planType.toUpperCase()
        : vscode.l10n.t('Unknown')
    tooltip.appendMarkdown(
      `${vscode.l10n.t('Runtime auth')}: ${escapeMarkdown(runtimeLabel)} (${vscode.l10n.t('external session')} · ${escapeMarkdown(email)} · ${escapeMarkdown(plan)})\n\n`,
    )
  } else {
    const activeProfile = profiles.find(
      (profile) => profile.id === runtimeSession.matchedProfileId,
    )
    const runtimeLabel = getRuntimePrimaryLabel(runtimeSession, activeProfile)
    const alias = activeProfile ? getRuntimeAlias(runtimeSession, activeProfile) : undefined
    tooltip.appendMarkdown(
      `${vscode.l10n.t('Runtime auth')}: ${escapeMarkdown(runtimeLabel)}${
        alias ? ` (${escapeMarkdown(alias)})` : ''
      }\n\n`,
    )
  }

  if (runtimeSession?.warningMessage) {
    tooltip.appendMarkdown(
      `> ${escapeMarkdown(runtimeSession.warningMessage)}\n\n`,
    )
  }

  if (!profiles || profiles.length === 0) {
    tooltip.appendMarkdown(`${vscode.l10n.t('No profiles yet.')}\n\n`)
  } else {
    const activeId =
      runtimeSession?.kind === 'matchedProfile'
        ? runtimeSession.matchedProfileId
        : undefined
    for (const p of profiles) {
      const isActive = Boolean(activeId && p.id === activeId)
      const label = escapeMarkdown(
        isActive && runtimeSession?.kind === 'matchedProfile'
          ? getRuntimePrimaryLabel(runtimeSession, p)
          : getProfilePrimaryLabel(p),
      )
      const alias = escapeMarkdown(
        isActive && runtimeSession?.kind === 'matchedProfile'
          ? getRuntimeAlias(runtimeSession, p) || ''
          : getProfileAlias(p) || '',
      )
      const rawPlan = p.planType || 'Unknown'
      const planDisplay =
        rawPlan === 'Unknown' ? vscode.l10n.t('Unknown') : rawPlan.toUpperCase()
      const plan = escapeMarkdown(planDisplay)
      const switchUri = buildCommandUri('codex-switch.profile.activate', [p.id])
      const emailDisplay = getProfileFullEmail(p) || vscode.l10n.t('Unknown')
      const linkTitle = escapeLinkTitle(emailDisplay)
      const linkedName = isActive
        ? `[**${label}**](${switchUri} "${linkTitle}")`
        : `[${label}](${switchUri} "${linkTitle}")`
      const suffixParts = [alias || undefined, plan]
      const suffix = suffixParts.filter(Boolean).join(' · ')

      if (isActive) {
        const activeLabel = escapeMarkdown(vscode.l10n.t('Active'))
        tooltip.appendMarkdown(
          `* ${linkedName}${
            suffix ? ` - ${suffix}` : ''
          } <span style="color: var(--vscode-textLink-activeForeground); font-weight: 600;">(${activeLabel})</span>\n`,
        )
      } else {
        tooltip.appendMarkdown(
          `* ${linkedName}${suffix ? ` - ${suffix}` : ''}\n`,
        )
      }
    }
    tooltip.appendMarkdown('\n')
  }

  tooltip.appendMarkdown('---\n\n')
  tooltip.appendMarkdown(
    `[${vscode.l10n.t('Manage profiles')}](command:codex-switch.profile.manage)\n\n`,
  )
  return tooltip
}
