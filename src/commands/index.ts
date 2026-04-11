import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ProfileManager } from '../auth/profile-manager'
import {
  getDefaultCodexAuthPath,
  loadAuthDataFromFile,
  shouldUseWslAuthPath,
} from '../auth/auth-manager'
import { pickBestQuotaProfileId } from '../health/profile-health'
import { RefreshCoordinator } from '../ui/refresh-coordinator'
import { ProfileTreeNode, ProfileTreeProvider } from '../ui/profile-tree'

type StatusBarClickBehavior = 'cycle' | 'toggleLast' | 'bestQuota'
type StatusBarSwitchTrigger = 'click' | 'doubleClick'

const STATUS_BAR_DOUBLE_CLICK_WINDOW_MS = 350

let pendingStatusBarClickAt = 0
let pendingStatusBarClickTimer: ReturnType<typeof setTimeout> | undefined

interface ProfileQuickPickItem extends vscode.QuickPickItem {
  profileId: string
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
  const activeId = await profileManager.getActiveProfileId()
  return profiles.map((profile) => ({
    label: profile.name,
    description:
      profile.email && profile.email !== 'Unknown' ? profile.email : undefined,
    detail: profile.id === activeId ? vscode.l10n.t('Active') : undefined,
    profileId: profile.id,
  }))
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

  return vscode.window.showQuickPick(items, { placeHolder })
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

async function activateProfileById(
  profileManager: ProfileManager,
  refreshCoordinator: RefreshCoordinator,
  profileId: string,
): Promise<boolean> {
  const ok = await profileManager.setActiveProfileId(profileId)
  if (!ok) {
    return false
  }

  await afterProfileChange(refreshCoordinator, profileId)
  await maybeReloadWindowAfterProfileSwitch()
  return true
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
      if (!pick) {
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
      const behavior = getStatusBarClickBehavior()
      if (behavior === 'toggleLast') {
        const newId = await profileManager.toggleLastProfileId()
        if (!newId) {
          await vscode.commands.executeCommand('codex-switch.profile.switch')
          return
        }

        await afterProfileChange(refreshCoordinator, newId)
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
        await profileManager.setActiveProfileId(existing.id)
        await afterProfileChange(refreshCoordinator, existing.id)
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
      await profileManager.setActiveProfileId(profile.id)
      await afterProfileChange(refreshCoordinator, profile.id)
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
        await profileManager.setActiveProfileId(existing.id)
        await afterProfileChange(refreshCoordinator, existing.id)
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
      await profileManager.setActiveProfileId(profile.id)
      await afterProfileChange(refreshCoordinator, profile.id)
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
    },
  )

  const refreshQuotaCommand = vscode.commands.registerCommand(
    'codex-switch.profile.refreshQuota',
    async (target?: unknown) => {
      const profileId = resolveProfileId(target)
      await refreshCoordinator.refreshQuota(profileId)
    },
  )

  const refreshTokenCommand = vscode.commands.registerCommand(
    'codex-switch.profile.refreshToken',
    async (target?: unknown) => {
      const pick = await pickProfile(
        profileManager,
        vscode.l10n.t('Refresh token'),
        target,
      )
      if (!pick) {
        return
      }

      const ok = await refreshCoordinator.refreshToken(pick.profileId)
      if (!ok) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Failed to refresh token for "{0}".', pick.label),
        )
        return
      }

      await refreshCoordinator.refreshQuota(pick.profileId)
    },
  )

  const refreshAllCommand = vscode.commands.registerCommand(
    'codex-switch.profile.refreshAll',
    async () => {
      await refreshCoordinator.refreshAll()
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
  )
}
