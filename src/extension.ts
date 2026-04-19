import * as vscode from 'vscode'
import { ProfileManager } from './auth/profile-manager'
import { ProfileHealthService } from './health/profile-health-service'
import {
  createStatusBarItem,
  getStatusBarItem,
  updateProfileStatus,
} from './ui/status-bar'
import {
  ProfileTreeItem,
  ProfileTreeNode,
  ProfileTreeProvider,
} from './ui/profile-tree'
import { RefreshCoordinator } from './ui/refresh-coordinator'
import { registerCommands } from './commands'
import { debugLog, errorLog } from './utils/log'
import { ProfileSummary, RuntimeIsolationStatus, RuntimeSession } from './types'
import { adoptManagedRuntimeEnvironmentFromContext } from './auth/runtime-isolation'

let profileManager: ProfileManager | undefined
let profileHealthService: ProfileHealthService | undefined
let profileTreeProvider: ProfileTreeProvider | undefined
let refreshCoordinator: RefreshCoordinator | undefined
let cachedProfiles: ProfileSummary[] = []
let cachedRuntimeSession: RuntimeSession | null = null
let lastWarningSignature: string | undefined
const RELAUNCH_ISOLATED_WINDOW_COMMAND =
  'codex-switch.runtime.relaunchIsolatedWindow'

export function activate(context: vscode.ExtensionContext) {
  debugLog('Codex Switch activated')
  if (adoptManagedRuntimeEnvironmentFromContext(context)) {
    debugLog('Adopted managed isolated runtime environment from user-data dir')
  }

  const statusBarItem = createStatusBarItem()
  context.subscriptions.push(statusBarItem)

  profileManager = new ProfileManager(context)
  profileHealthService = new ProfileHealthService(profileManager)
  profileTreeProvider = new ProfileTreeProvider()

  const profileTreeView = vscode.window.createTreeView<ProfileTreeNode>(
    'codexSwitchProfiles',
    {
      treeDataProvider: profileTreeProvider,
      showCollapseAll: true,
    },
  )
  context.subscriptions.push(
    profileTreeView,
    profileHealthService,
    profileTreeProvider,
    profileTreeView.onDidExpandElement(({ element }) => {
      if (element instanceof ProfileTreeItem) {
        profileTreeProvider?.setExpanded(element.profile.id, true)
        return
      }
      if ('nodeId' in element && typeof element.nodeId === 'string') {
        profileTreeProvider?.setExpanded(element.nodeId, true)
      }
    }),
    profileTreeView.onDidCollapseElement(({ element }) => {
      if (element instanceof ProfileTreeItem) {
        profileTreeProvider?.setExpanded(element.profile.id, false)
        return
      }
      if ('nodeId' in element && typeof element.nodeId === 'string') {
        profileTreeProvider?.setExpanded(element.nodeId, false)
      }
    }),
  )

  const refreshUi = async () => {
    try {
      await refreshProfileUi()
    } catch (error) {
      errorLog('Error refreshing profile UI:', error)
      cachedProfiles = []
      cachedRuntimeSession = null
      updateProfileStatus(null, [])
      profileTreeProvider?.setState([], null, new Map())
    }
  }

  refreshCoordinator = new RefreshCoordinator(refreshUi, profileHealthService)
  registerCommands(
    context,
    profileManager,
    refreshCoordinator,
    profileTreeProvider,
    profileTreeView,
  )
  context.subscriptions.push(
    ...profileManager.createWatchers(() => {
      void refreshUi()
    }),
    profileHealthService.onDidChangeState(() => {
      // Optimization note [2026-04-12 04:42 ICT]:
      // Health refreshes emit frequently per profile. Re-render from cached
      // profile metadata instead of reloading every stored auth payload on
      // each tick; this removes redundant storage reads and keeps updates cheap.
      renderProfileUi()
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('codexSwitch') ||
        event.affectsConfiguration('codexUsage')
      ) {
        void refreshUi()
      }
    }),
  )

  void refreshCoordinator.refreshAll()
}

function renderProfileUi() {
  if (!profileHealthService || !profileTreeProvider) {
    updateProfileStatus(null, [])
    return
  }

  profileTreeProvider.setState(
    cachedProfiles,
    cachedRuntimeSession,
    profileHealthService.getStates(),
  )

  if (!cachedRuntimeSession) {
    updateProfileStatus(null, cachedProfiles)
    return
  }

  if (cachedRuntimeSession.kind !== 'matchedProfile') {
    updateProfileStatus(cachedRuntimeSession, cachedProfiles)
    return
  }

  const activeProfile =
    cachedProfiles.find(
      (profile) => profile.id === cachedRuntimeSession?.matchedProfileId,
    ) || null
  if (!activeProfile) {
    updateProfileStatus(cachedRuntimeSession, cachedProfiles)
    return
  }

  updateProfileStatus(
    cachedRuntimeSession,
    cachedProfiles,
    profileHealthService.getState(activeProfile.id),
  )
}

interface WarningAction {
  label: string
  command: string
}

function maybeShowWarning(message: string | undefined, action?: WarningAction) {
  const signature = message?.trim() || undefined
  if (!signature) {
    lastWarningSignature = undefined
    return
  }

  // Include the command in the de-duplication key so the same warning text can
  // safely gain or lose a recovery action after configuration changes.
  const actionSignature = action
    ? `${signature}\ncommand:${action.command}`
    : signature
  if (actionSignature === lastWarningSignature) {
    return
  }

  lastWarningSignature = actionSignature
  const warning = action
    ? vscode.window.showWarningMessage(signature, action.label)
    : vscode.window.showWarningMessage(signature)

  if (!action) {
    return
  }

  void warning.then((picked) => {
    if (picked !== action.label) {
      return
    }

    // The relaunch command already owns descriptor validation and launch
    // failure handling. Keeping this path as a command dispatch avoids
    // duplicating process-spawn behavior in the activation warning flow.
    void vscode.commands.executeCommand(action.command)
  })
}

function getRuntimeIsolationWarningAction(
  isolationStatus: RuntimeIsolationStatus,
): WarningAction | undefined {
  if (!isolationStatus.requiresRelaunch || !isolationStatus.warningMessage) {
    return undefined
  }

  return {
    label: vscode.l10n.t('Open isolated runtime window'),
    command: RELAUNCH_ISOLATED_WINDOW_COMMAND,
  }
}

async function refreshProfileUi() {
  if (!profileManager || !profileHealthService || !profileTreeProvider) {
    updateProfileStatus(null, [])
    return
  }

  const profiles = await profileManager.listProfiles()
  await profileHealthService.primeProfiles(profiles)
  const runtimeSession = await profileManager.getRuntimeSession(profiles)
  const isolationStatus = profileManager.getRuntimeIsolationStatus()

  cachedProfiles = profiles
  cachedRuntimeSession = runtimeSession
  const warningMessage =
    isolationStatus.warningMessage || runtimeSession.warningMessage
  maybeShowWarning(
    warningMessage,
    isolationStatus.warningMessage
      ? getRuntimeIsolationWarningAction(isolationStatus)
      : undefined,
  )
  renderProfileUi()
}

export function deactivate() {
  const statusBarItem = getStatusBarItem()
  if (statusBarItem) {
    statusBarItem.dispose()
  }
  profileHealthService?.dispose()
  profileTreeProvider?.dispose()
}
