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
import { ProfileSummary } from './types'

let profileManager: ProfileManager | undefined
let profileHealthService: ProfileHealthService | undefined
let profileTreeProvider: ProfileTreeProvider | undefined
let refreshCoordinator: RefreshCoordinator | undefined
let cachedProfiles: ProfileSummary[] = []
let cachedActiveProfileId: string | undefined

export function activate(context: vscode.ExtensionContext) {
  debugLog('Codex Switch activated')

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
      }
    }),
    profileTreeView.onDidCollapseElement(({ element }) => {
      if (element instanceof ProfileTreeItem) {
        profileTreeProvider?.setExpanded(element.profile.id, false)
      }
    }),
  )

  const refreshUi = async () => {
    try {
      await refreshProfileUi()
    } catch (error) {
      errorLog('Error refreshing profile UI:', error)
      updateProfileStatus(null, [])
      profileTreeProvider?.setState([], undefined, new Map())
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
  void profileManager.syncActiveProfileToCodexAuthFile()
}

function renderProfileUi() {
  if (!profileHealthService || !profileTreeProvider) {
    updateProfileStatus(null, [])
    return
  }

  profileTreeProvider.setState(
    cachedProfiles,
    cachedActiveProfileId,
    profileHealthService.getStates(),
  )

  if (!cachedActiveProfileId) {
    updateProfileStatus(null, cachedProfiles)
    return
  }

  const activeProfile =
    cachedProfiles.find((profile) => profile.id === cachedActiveProfileId) ||
    null
  if (!activeProfile) {
    updateProfileStatus(null, cachedProfiles)
    return
  }

  updateProfileStatus(
    activeProfile,
    cachedProfiles,
    profileHealthService.getState(activeProfile.id),
  )
}

async function refreshProfileUi() {
  if (!profileManager || !profileHealthService || !profileTreeProvider) {
    updateProfileStatus(null, [])
    return
  }

  const profiles = await profileManager.listProfiles()
  await profileHealthService.primeProfiles(profiles)
  let activeId = await profileManager.getActiveProfileId()
  if (activeId && !profiles.some((profile) => profile.id === activeId)) {
    await profileManager.setActiveProfileId(undefined)
    activeId = undefined
  }

  cachedProfiles = profiles
  cachedActiveProfileId = activeId
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
