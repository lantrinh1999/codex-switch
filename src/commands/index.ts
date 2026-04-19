import * as vscode from 'vscode'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ProfileManager } from '../auth/profile-manager'
import {
  getDefaultCodexAuthPath,
  loadAuthDataFromFile,
  shouldUseWslAuthPath,
} from '../auth/auth-manager'
import {
  buildIsolatedLaunchCommand,
  ensureWorkspaceIsolationDirs,
  getRuntimeIsolationMode,
} from '../auth/runtime-isolation'
import { pickBestQuotaProfileId } from '../health/profile-health'
import { ProfileSummary, RuntimeSession } from '../types'
import { RefreshCoordinator } from '../ui/refresh-coordinator'
import { ProfileTreeNode, ProfileTreeProvider } from '../ui/profile-tree'

type StatusBarClickBehavior = 'cycle' | 'toggleLast' | 'bestQuota'
type StatusBarSwitchTrigger = 'click' | 'doubleClick'

const STATUS_BAR_DOUBLE_CLICK_WINDOW_MS = 350

let pendingStatusBarClickAt = 0
let pendingStatusBarClickTimer: ReturnType<typeof setTimeout> | undefined

interface ProfileQuickPickItem extends vscode.QuickPickItem {
  profileId: string
  isInfoItem?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function resolveProfileId(target: unknown): string | undefined {
  if (typeof target === 'string' && target.trim()) {
    return target
  }

  if (!isRecord(target)) {
    return undefined
  }

  if (typeof target.profileId === 'string' && target.profileId.trim()) {
    return target.profileId
  }

  if (
    isRecord(target.profile) &&
    typeof target.profile.id === 'string' &&
    target.profile.id.trim()
  ) {
    return target.profile.id
  }

  return undefined
}

function resolveRawValue(target: unknown): string | undefined {
  if (!isRecord(target)) {
    return undefined
  }
  return typeof target.rawValue === 'string' && target.rawValue.trim()
    ? target.rawValue
    : undefined
}

function getDefaultSettingsExportUri(): vscode.Uri {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const baseDir = workspacePath || os.homedir()
  return vscode.Uri.file(path.join(baseDir, 'codex-switch-profiles.json'))
}

function getLoginCommandText(): string {
  return shouldUseWslAuthPath() ? 'wsl codex login' : 'codex login'
}

function getStatusBarClickBehavior(): StatusBarClickBehavior {
  const raw = vscode.workspace
    .getConfiguration('codexSwitch')
    .get<StatusBarClickBehavior>('statusBarClickBehavior', 'cycle')
  if (raw === 'toggleLast' || raw === 'bestQuota') {
    return raw
  }
  return 'cycle'
}

function getStatusBarSwitchTrigger(): StatusBarSwitchTrigger {
  const raw = vscode.workspace
    .getConfiguration('codexSwitch')
    .get<StatusBarSwitchTrigger>('statusBarSwitchTrigger', 'click')
  return raw === 'doubleClick' ? 'doubleClick' : 'click'
}

function clearPendingStatusBarClick(): void {
  pendingStatusBarClickAt = 0
  if (pendingStatusBarClickTimer) {
    clearTimeout(pendingStatusBarClickTimer)
    pendingStatusBarClickTimer = undefined
  }
}

async function maybeReloadWindowAfterProfileSwitch(): Promise<void> {
  if (getRuntimeIsolationMode() === 'isolatedInstance') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow')
    return
  }

  const reloadAfterSwitch = vscode.workspace
    .getConfiguration('codexSwitch')
    .get<boolean>('reloadWindowAfterProfileSwitch', false)
  if (!reloadAfterSwitch) {
    return
  }
  await vscode.commands.executeCommand('workbench.action.reloadWindow')
}

async function getProfileQuickPickItems(
  profileManager: ProfileManager,
): Promise<ProfileQuickPickItem[]> {
  const profiles = await profileManager.listProfiles()
  const runtimeSession = await profileManager.getRuntimeSession(profiles)
  const items: ProfileQuickPickItem[] = profiles.map((profile) => ({
    label: profile.name,
    description:
      profile.email && profile.email !== 'Unknown' ? profile.email : undefined,
    detail:
      runtimeSession.kind === 'matchedProfile' &&
      profile.id === runtimeSession.matchedProfileId
        ? vscode.l10n.t('Runtime active')
        : undefined,
    profileId: profile.id,
  }))

  if (runtimeSession.kind === 'externalAuth') {
    items.unshift({
      label: vscode.l10n.t('Current runtime auth'),
      description:
        runtimeSession.authData?.email &&
        runtimeSession.authData.email !== 'Unknown'
          ? runtimeSession.authData.email
          : undefined,
      detail: vscode.l10n.t('External auth.json session is active'),
      profileId: '__runtime_external__',
      isInfoItem: true,
      alwaysShow: true,
    })
  } else if (runtimeSession.kind === 'noAuth') {
    items.unshift({
      label: vscode.l10n.t('Current runtime auth'),
      detail: vscode.l10n.t('No auth.json session is active'),
      profileId: '__runtime_none__',
      isInfoItem: true,
      alwaysShow: true,
    })
  }

  return items
}

async function pickProfile(
  profileManager: ProfileManager,
  placeHolder: string,
  target?: unknown,
): Promise<ProfileQuickPickItem | undefined> {
  const targetId = resolveProfileId(target)
  if (targetId) {
    const profile = await profileManager.getProfile(targetId)
    if (profile) {
      return {
        label: profile.name,
        description:
          profile.email && profile.email !== 'Unknown'
            ? profile.email
            : undefined,
        profileId: profile.id,
      }
    }
  }

  const items = await getProfileQuickPickItems(profileManager)
  if (items.length === 0) {
    return undefined
  }

  const picked = await vscode.window.showQuickPick(items, { placeHolder })
  if (!picked || picked.isInfoItem) {
    return undefined
  }

  return picked
}

async function getRuntimeSession(
  profileManager: ProfileManager,
): Promise<RuntimeSession> {
  const profiles = await profileManager.listProfiles()
  return profileManager.getRuntimeSession(profiles)
}

function getRuntimeConflictMessage(
  runtimeSession: RuntimeSession,
): string | null {
  if (runtimeSession.kind !== 'externalAuth') {
    return null
  }

  return runtimeSession.warningMessage
    ? runtimeSession.warningMessage
    : vscode.l10n.t(
        'Current runtime auth is an external auth.json session. Pick a saved profile to take over the runtime.',
      )
}

async function relaunchIntoManagedIsolation(
  profileManager: ProfileManager,
): Promise<void> {
  const isolationStatus = profileManager.getRuntimeIsolationStatus()
  if (isolationStatus.isManagedWindow && !isolationStatus.requiresRelaunch) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'This workspace is already running inside its managed isolated VS Code instance.',
      ),
    )
    return
  }

  const descriptor = isolationStatus.descriptor
  if (!descriptor) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        'Unable to derive a managed isolation target for this window.',
      ),
    )
    return
  }

  if (descriptor.launchTarget.kind === 'unsupported') {
    void vscode.window.showErrorMessage(descriptor.launchTarget.reason)
    return
  }

  const launchCommand = buildIsolatedLaunchCommand(descriptor)
  if (!launchCommand) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        'Unable to build an isolated VS Code launch command for this workspace.',
      ),
    )
    return
  }

  ensureWorkspaceIsolationDirs(descriptor)

  try {
    const child = spawn(launchCommand.executable, launchCommand.args, {
      detached: true,
      env: launchCommand.env,
      stdio: 'ignore',
    })
    child.unref()
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : vscode.l10n.t('Unknown launch error.')
    await vscode.env.clipboard.writeText(launchCommand.printableCommand)
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        'Failed to launch the isolated VS Code instance: {0}. The launch command was copied to the clipboard.',
        message,
      ),
    )
    return
  }

  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Launched an isolated VS Code instance for this workspace. Close the current window after the new instance opens.',
    ),
  )
}

async function afterProfileChange(
  refreshCoordinator: RefreshCoordinator,
  profileId?: string,
): Promise<void> {
  await refreshCoordinator.refreshUi()
  if (profileId) {
    void refreshCoordinator.refreshQuota(profileId)
  }
}

function getProfileNotificationName(
  profile: Pick<ProfileSummary, 'name'> | undefined,
  fallbackProfileId: string,
): string {
  return profile?.name || fallbackProfileId
}

function showActionInformationMessage(message: string): void {
  void vscode.window.showInformationMessage(message)
}

// Only direct user-invoked commands should call these helpers. Internal
// follow-up refreshes triggered as part of a larger action stay silent so the
// user gets one clear confirmation instead of multiple stacked notifications.
function notifyProfileActivated(
  profile: Pick<ProfileSummary, 'name'> | undefined,
  fallbackProfileId: string,
): void {
  showActionInformationMessage(
    vscode.l10n.t(
      'Switched to profile "{0}".',
      getProfileNotificationName(profile, fallbackProfileId),
    ),
  )
}

async function activateProfileById(
  profileManager: ProfileManager,
  refreshCoordinator: RefreshCoordinator,
  profileId: string,
): Promise<ProfileSummary | undefined> {
  const profile = await profileManager.getProfile(profileId)
  const ok = await profileManager.setActiveProfileId(profileId)
  if (!ok) {
    return undefined
  }

  await afterProfileChange(refreshCoordinator, profileId)
  notifyProfileActivated(profile, profileId)
  await maybeReloadWindowAfterProfileSwitch()
  return profile
}

/**
 * Register all extension commands
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  profileManager: ProfileManager,
  refreshCoordinator: RefreshCoordinator,
  profileTreeProvider?: ProfileTreeProvider,
  profileTreeView?: vscode.TreeView<ProfileTreeNode>,
) {
  const loginCommand = vscode.commands.registerCommand(
    'codex-switch.login',
    async () => {
      const loginCommandText = getLoginCommandText()
      const loginSequence = `${loginCommandText}\n`
      const manageLabel = vscode.l10n.t('Manage profiles')
      const openTerminalLabel = vscode.l10n.t('Open terminal')
      const copyCommandLabel = vscode.l10n.t('Copy command')

      const selection = await vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Authentication required. Add a profile or run "{0}".',
          loginCommandText,
        ),
        manageLabel,
        openTerminalLabel,
        copyCommandLabel,
      )

      if (selection === manageLabel) {
        await vscode.commands.executeCommand('codex-switch.profile.manage')
      } else if (selection === openTerminalLabel) {
        void vscode.commands.executeCommand('workbench.action.terminal.new')
        setTimeout(() => {
          void vscode.commands.executeCommand(
            'workbench.action.terminal.sendSequence',
            { text: loginSequence },
          )
        }, 500)
      } else if (selection === copyCommandLabel) {
        await vscode.env.clipboard.writeText(loginCommandText)
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Command "{0}" copied to clipboard.', loginCommandText),
        )
      }
    },
  )

  const switchProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.switch',
    async () => {
      const items = await getProfileQuickPickItems(profileManager)
      if (items.length === 0) {
        await vscode.commands.executeCommand('codex-switch.profile.manage')
        return
      }

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Switch profile'),
      })
      if (!pick || pick.isInfoItem) {
        return
      }

      await activateProfileById(
        profileManager,
        refreshCoordinator,
        pick.profileId,
      )
    },
  )

  const activateProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.activate',
    async (target?: unknown) => {
      const profileId = resolveProfileId(target)
      if (!profileId) {
        await vscode.commands.executeCommand('codex-switch.profile.switch')
        return
      }

      await activateProfileById(profileManager, refreshCoordinator, profileId)
    },
  )

  const toggleLastProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.toggleLast',
    async () => {
      const runtimeSession = await getRuntimeSession(profileManager)
      const runtimeConflictMessage = getRuntimeConflictMessage(runtimeSession)
      if (runtimeConflictMessage) {
        void vscode.window.showWarningMessage(runtimeConflictMessage)
        await vscode.commands.executeCommand('codex-switch.profile.switch')
        return
      }

      const behavior = getStatusBarClickBehavior()
      if (behavior === 'toggleLast') {
        const newId = await profileManager.toggleLastProfileId()
        if (!newId) {
          await vscode.commands.executeCommand('codex-switch.profile.switch')
          return
        }

        const profile = await profileManager.getProfile(newId)
        await afterProfileChange(refreshCoordinator, newId)
        notifyProfileActivated(profile, newId)
        await maybeReloadWindowAfterProfileSwitch()
        return
      }

      const profiles = await profileManager.listProfiles()
      if (profiles.length === 0) {
        await vscode.commands.executeCommand('codex-switch.profile.manage')
        return
      }

      const activeId = await profileManager.getActiveProfileId()
      if (behavior === 'bestQuota') {
        await refreshCoordinator.refreshQuota()
        const bestProfileId = pickBestQuotaProfileId(
          profiles,
          refreshCoordinator.getHealthStates(),
          activeId,
        )

        if (bestProfileId) {
          if (bestProfileId === activeId) {
            const activeProfile = profiles.find(
              (profile) => profile.id === activeId,
            )
            showActionInformationMessage(
              vscode.l10n.t(
                'Profile "{0}" already has the best available quota.',
                getProfileNotificationName(
                  activeProfile,
                  activeId || vscode.l10n.t('current'),
                ),
              ),
            )
            return
          }

          await activateProfileById(
            profileManager,
            refreshCoordinator,
            bestProfileId,
          )
          return
        }
      }

      const currentIndex = profiles.findIndex(
        (profile) => profile.id === activeId,
      )
      const nextIndex =
        currentIndex === -1 ? 0 : (currentIndex + 1) % profiles.length
      const nextProfile = profiles[nextIndex]
      await activateProfileById(
        profileManager,
        refreshCoordinator,
        nextProfile.id,
      )
    },
  )

  const statusBarActionCommand = vscode.commands.registerCommand(
    'codex-switch.profile.statusBarAction',
    async () => {
      const trigger = getStatusBarSwitchTrigger()
      if (trigger === 'click') {
        clearPendingStatusBarClick()
        await vscode.commands.executeCommand('codex-switch.profile.toggleLast')
        return
      }

      const now = Date.now()
      if (
        pendingStatusBarClickAt > 0 &&
        now - pendingStatusBarClickAt <= STATUS_BAR_DOUBLE_CLICK_WINDOW_MS
      ) {
        clearPendingStatusBarClick()
        await vscode.commands.executeCommand('codex-switch.profile.toggleLast')
        return
      }

      clearPendingStatusBarClick()
      pendingStatusBarClickAt = now
      pendingStatusBarClickTimer = setTimeout(() => {
        clearPendingStatusBarClick()
      }, STATUS_BAR_DOUBLE_CLICK_WINDOW_MS)
      pendingStatusBarClickTimer.unref?.()
    },
  )

  const addFromCodexAuthFileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.addFromCodexAuthFile',
    async () => {
      const authPath = getDefaultCodexAuthPath()
      const loginCommandText = getLoginCommandText()
      const authData = await loadAuthDataFromFile(authPath)
      if (!authData) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'Could not read auth from {0}. Run "{1}" first.',
            authPath,
            loginCommandText,
          ),
        )
        return
      }

      const existing = await profileManager.findDuplicateProfile(authData)
      if (existing) {
        const replaceLabel = vscode.l10n.t('Replace')
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            'This account is already saved as profile "{0}". Replace it?',
            existing.name,
          ),
          { modal: true },
          replaceLabel,
        )
        if (pick !== replaceLabel) {
          return
        }

        await profileManager.replaceProfileAuth(existing.id, authData)
        const activated = await profileManager.setActiveProfileId(existing.id)
        if (!activated) {
          return
        }
        await afterProfileChange(refreshCoordinator, existing.id)
        showActionInformationMessage(
          vscode.l10n.t(
            'Updated profile "{0}" from current auth.json and set it active.',
            existing.name,
          ),
        )
        await maybeReloadWindowAfterProfileSwitch()
        return
      }

      const defaultName =
        authData.email && authData.email !== 'Unknown'
          ? authData.email.split('@')[0]
          : 'profile'

      const name = await vscode.window.showInputBox({
        prompt: vscode.l10n.t(
          'Profile name (for example "work" or "personal")',
        ),
        value: defaultName,
      })
      if (!name) {
        return
      }

      const profile = await profileManager.createProfile(name, authData)
      const activated = await profileManager.setActiveProfileId(profile.id)
      if (!activated) {
        return
      }
      await afterProfileChange(refreshCoordinator, profile.id)
      showActionInformationMessage(
        vscode.l10n.t(
          'Imported current auth.json as profile "{0}" and set it active.',
          profile.name,
        ),
      )
      await maybeReloadWindowAfterProfileSwitch()
    },
  )

  const loginViaCliCommand = vscode.commands.registerCommand(
    'codex-switch.profile.login',
    async () => {
      const authPath = getDefaultCodexAuthPath()
      const loginSequence = `${getLoginCommandText()}\n`

      void vscode.commands.executeCommand('workbench.action.terminal.new')
      setTimeout(() => {
        void vscode.commands.executeCommand(
          'workbench.action.terminal.sendSequence',
          {
            text: loginSequence,
          },
        )
      }, 500)

      const start = Date.now()
      const maxWaitMs = 10 * 60 * 1000

      let watcher: fs.FSWatcher | undefined
      let done = false

      const cleanup = () => {
        if (done) {
          return
        }
        done = true
        if (watcher) {
          try {
            watcher.close()
          } catch {
            // ignore
          }
        }
      }

      const promptImport = async () => {
        cleanup()
        const importLabel = vscode.l10n.t('Import')
        const pick = await vscode.window.showInformationMessage(
          vscode.l10n.t(
            'Codex auth file detected at {0}. Import it as a profile?',
            authPath,
          ),
          importLabel,
        )
        if (pick === importLabel) {
          await vscode.commands.executeCommand(
            'codex-switch.profile.addFromCodexAuthFile',
          )
        }
      }

      try {
        const dir = path.dirname(authPath)
        if (fs.existsSync(dir)) {
          watcher = fs.watch(
            dir,
            { persistent: false },
            async (_event, filename) => {
              if (!filename) {
                return
              }
              if (String(filename).toLowerCase() !== 'auth.json') {
                return
              }
              if (Date.now() - start > maxWaitMs) {
                cleanup()
                return
              }
              if (fs.existsSync(authPath)) {
                await promptImport()
              }
            },
          )
        }
      } catch {
        // Best effort; fall back to manual import.
      }

      const importNowLabel = vscode.l10n.t('Import now')
      const manageLabel = vscode.l10n.t('Manage profiles')
      const msg = await vscode.window.showInformationMessage(
        vscode.l10n.t(
          'After completing the login flow, import the current environment auth.json from {0} as a profile.',
          authPath,
        ),
        importNowLabel,
        manageLabel,
      )

      if (msg === importNowLabel) {
        cleanup()
        await vscode.commands.executeCommand(
          'codex-switch.profile.addFromCodexAuthFile',
        )
      } else if (msg === manageLabel) {
        cleanup()
        await vscode.commands.executeCommand('codex-switch.profile.manage')
      } else {
        setTimeout(() => cleanup(), maxWaitMs)
      }
    },
  )

  const addFromFileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.addFromFile',
    async () => {
      const uri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: vscode.l10n.t('Import auth.json'),
        filters: { JSON: ['json'] },
      })
      if (!uri || uri.length === 0) {
        return
      }

      const authData = await loadAuthDataFromFile(uri[0].fsPath)
      if (!authData) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Selected file is not a valid auth.json.'),
        )
        return
      }

      const existing = await profileManager.findDuplicateProfile(authData)
      if (existing) {
        const replaceLabel = vscode.l10n.t('Replace')
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            'This account is already saved as profile "{0}". Replace it?',
            existing.name,
          ),
          { modal: true },
          replaceLabel,
        )
        if (pick !== replaceLabel) {
          return
        }

        await profileManager.replaceProfileAuth(existing.id, authData)
        const activated = await profileManager.setActiveProfileId(existing.id)
        if (!activated) {
          return
        }
        await afterProfileChange(refreshCoordinator, existing.id)
        showActionInformationMessage(
          vscode.l10n.t(
            'Updated profile "{0}" from file and set it active.',
            existing.name,
          ),
        )
        await maybeReloadWindowAfterProfileSwitch()
        return
      }

      const defaultName =
        authData.email && authData.email !== 'Unknown'
          ? authData.email.split('@')[0]
          : 'profile'

      const name = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Profile name'),
        value: defaultName,
      })
      if (!name) {
        return
      }

      const profile = await profileManager.createProfile(name, authData)
      const activated = await profileManager.setActiveProfileId(profile.id)
      if (!activated) {
        return
      }
      await afterProfileChange(refreshCoordinator, profile.id)
      showActionInformationMessage(
        vscode.l10n.t(
          'Imported profile "{0}" from file and set it active.',
          profile.name,
        ),
      )
      await maybeReloadWindowAfterProfileSwitch()
    },
  )

  const exportSettingsCommand = vscode.commands.registerCommand(
    'codex-switch.profile.exportSettings',
    async () => {
      const saveUri = await vscode.window.showSaveDialog({
        saveLabel: vscode.l10n.t('Export profiles'),
        defaultUri: getDefaultSettingsExportUri(),
        filters: { JSON: ['json'] },
      })
      if (!saveUri) {
        return
      }

      const { data, skipped } = await profileManager.exportProfilesForTransfer()
      fs.writeFileSync(saveUri.fsPath, JSON.stringify(data, null, 2), 'utf8')

      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Exported {0} profile(s) to {1}. Skipped {2} profile(s) without tokens.',
          data.profiles.length,
          saveUri.fsPath,
          skipped,
        ),
      )
    },
  )

  const importSettingsCommand = vscode.commands.registerCommand(
    'codex-switch.profile.importSettings',
    async () => {
      const uri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: vscode.l10n.t('Import profiles'),
        filters: { JSON: ['json'] },
      })
      if (!uri || uri.length === 0) {
        return
      }

      let payload: unknown
      try {
        payload = JSON.parse(fs.readFileSync(uri[0].fsPath, 'utf8')) as unknown
      } catch {
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Selected file is not a valid JSON profiles export.'),
        )
        return
      }

      try {
        const result = await profileManager.importProfilesFromTransfer(payload)
        await refreshCoordinator.refreshAll()
        await maybeReloadWindowAfterProfileSwitch()
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            'Import completed: created {0}, updated {1}, skipped {2}.',
            result.created,
            result.updated,
            result.skipped,
          ),
        )
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : vscode.l10n.t('Unknown import error.')
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Failed to import profiles: {0}', message),
        )
      }
    },
  )

  const renameProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.rename',
    async (target?: unknown) => {
      const pick = await pickProfile(
        profileManager,
        vscode.l10n.t('Rename profile'),
        target,
      )
      if (!pick) {
        return
      }

      const newName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('New profile name'),
        value: pick.label,
      })
      if (!newName) {
        return
      }

      await profileManager.renameProfile(pick.profileId, newName)
      await refreshCoordinator.refreshUi()
      showActionInformationMessage(
        vscode.l10n.t('Renamed profile "{0}" to "{1}".', pick.label, newName),
      )
    },
  )

  const deleteProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.delete',
    async (target?: unknown) => {
      const pick = await pickProfile(
        profileManager,
        vscode.l10n.t('Delete profile'),
        target,
      )
      if (!pick) {
        return
      }

      const deleteLabel = vscode.l10n.t('Delete')
      const ok = await vscode.window.showWarningMessage(
        vscode.l10n.t('Delete profile "{0}"?', pick.label),
        { modal: true },
        deleteLabel,
      )
      if (ok !== deleteLabel) {
        return
      }

      await profileManager.deleteProfile(pick.profileId)
      await refreshCoordinator.refreshUi()
      showActionInformationMessage(
        vscode.l10n.t('Deleted profile "{0}".', pick.label),
      )
    },
  )

  const refreshQuotaCommand = vscode.commands.registerCommand(
    'codex-switch.profile.refreshQuota',
    async (target?: unknown) => {
      const profileId = resolveProfileId(target)
      const profile = profileId
        ? await profileManager.getProfile(profileId)
        : undefined
      await refreshCoordinator.refreshQuota(profileId)
      showActionInformationMessage(
        profileId
          ? vscode.l10n.t(
              'Refreshed quota for "{0}".',
              getProfileNotificationName(profile, profileId),
            )
          : vscode.l10n.t('Refreshed quota for all profiles.'),
      )
    },
  )

  const refreshTokenCommand = vscode.commands.registerCommand(
    'codex-switch.profile.refreshToken',
    async (target?: unknown) => {
      const pick = await pickProfile(
        profileManager,
        vscode.l10n.t('Renew token'),
        target,
      )
      if (!pick) {
        return
      }

      const ok = await refreshCoordinator.refreshToken(pick.profileId)
      if (!ok) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Failed to renew token for "{0}".', pick.label),
        )
        return
      }

      await refreshCoordinator.refreshQuota(pick.profileId)
      showActionInformationMessage(
        vscode.l10n.t('Renewed token for "{0}".', pick.label),
      )
    },
  )

  const refreshAllCommand = vscode.commands.registerCommand(
    'codex-switch.profile.refreshAll',
    async () => {
      await refreshCoordinator.refreshAll()
      showActionInformationMessage(
        vscode.l10n.t('Refreshed profiles and quotas.'),
      )
    },
  )

  const expandAllProfilesCommand = vscode.commands.registerCommand(
    'codex-switch.profile.expandAll',
    async () => {
      if (!profileTreeProvider || !profileTreeView) {
        return
      }

      profileTreeProvider.expandAll?.()
      for (const item of profileTreeProvider.getRootItems()) {
        await profileTreeView.reveal(item, {
          expand: true,
          focus: false,
          select: false,
        })
      }
    },
  )

  const copyValueCommand = vscode.commands.registerCommand(
    'codex-switch.profile.copyValue',
    async (target?: unknown) => {
      const value = resolveRawValue(target)
      if (!value) {
        return
      }

      await vscode.env.clipboard.writeText(value)
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Copied "{0}" to clipboard.', value),
      )
    },
  )

  const reloadWindowCommand = vscode.commands.registerCommand(
    'codex-switch.reloadWindow',
    async () => {
      await vscode.commands.executeCommand('workbench.action.reloadWindow')
    },
  )

  const relaunchIsolatedWindowCommand = vscode.commands.registerCommand(
    'codex-switch.runtime.relaunchIsolatedWindow',
    async () => {
      await relaunchIntoManagedIsolation(profileManager)
    },
  )

  const manageProfilesCommand = vscode.commands.registerCommand(
    'codex-switch.profile.manage',
    async () => {
      const authPath = getDefaultCodexAuthPath()
      const profiles = await profileManager.listProfiles()
      const hasProfiles = profiles.length > 0

      const action = await vscode.window.showQuickPick(
        [
          {
            label: vscode.l10n.t('Login via Codex CLI...'),
            command: 'codex-switch.profile.login',
          },
          ...(hasProfiles
            ? [
                {
                  label: vscode.l10n.t('Switch profile'),
                  command: 'codex-switch.profile.switch',
                },
                {
                  label: vscode.l10n.t('Refresh profiles'),
                  command: 'codex-switch.profile.refreshAll',
                },
              ]
            : []),
          {
            label: vscode.l10n.t('Add from current auth.json'),
            description: authPath,
            command: 'codex-switch.profile.addFromCodexAuthFile',
          },
          {
            label: vscode.l10n.t('Import from file...'),
            command: 'codex-switch.profile.addFromFile',
          },
          {
            label: vscode.l10n.t('Export profiles...'),
            command: 'codex-switch.profile.exportSettings',
          },
          {
            label: vscode.l10n.t('Import profiles...'),
            command: 'codex-switch.profile.importSettings',
          },
          {
            label: vscode.l10n.t('Open isolated runtime window'),
            command: 'codex-switch.runtime.relaunchIsolatedWindow',
          },
          ...(hasProfiles
            ? [
                {
                  label: vscode.l10n.t('Rename profile'),
                  command: 'codex-switch.profile.rename',
                },
                {
                  label: vscode.l10n.t('Delete profile'),
                  command: 'codex-switch.profile.delete',
                },
              ]
            : []),
        ],
        { placeHolder: vscode.l10n.t('Manage profiles') },
      )
      if (!action) {
        return
      }

      await vscode.commands.executeCommand(action.command)
    },
  )

  context.subscriptions.push(
    loginCommand,
    loginViaCliCommand,
    switchProfileCommand,
    activateProfileCommand,
    toggleLastProfileCommand,
    statusBarActionCommand,
    manageProfilesCommand,
    addFromCodexAuthFileCommand,
    addFromFileCommand,
    exportSettingsCommand,
    importSettingsCommand,
    renameProfileCommand,
    deleteProfileCommand,
    refreshQuotaCommand,
    refreshTokenCommand,
    refreshAllCommand,
    expandAllProfilesCommand,
    copyValueCommand,
    reloadWindowCommand,
    relaunchIsolatedWindowCommand,
  )
}
