const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
)

function getCommandContribution(command) {
  return manifest.contributes.commands.find((item) => item.command === command)
}

test('extension activates eagerly to claim workspace CODEX_HOME before other consumers', () => {
  assert.deepEqual(manifest.activationEvents, [
    '*',
    'onView:codexSwitchProfiles',
  ])
})

test('vsce scripts explicitly allow intentional star activation', () => {
  // The extension relies on eager activation so workspace-scoped CODEX_HOME is
  // visible before other consumers initialize. Keep packaging non-interactive
  // by declaring that startup cost explicitly in the vsce scripts.
  assert.match(
    manifest.scripts['vscode:package'],
    /--allow-star-activation(?:\s|$)/,
  )
  assert.match(
    manifest.scripts['vscode:publish'],
    /--allow-star-activation(?:\s|$)/,
  )
})

test('vsce packaging scripts compile inline instead of using vscode:prepublish', () => {
  // Node 24 warns when vsce spawns `npm run vscode:prepublish` with `shell:
  // true` and argument arrays. Keep the build step, but run it directly from
  // the public package/publish scripts so packaging stays quiet on supported
  // runtimes.
  assert.equal(manifest.scripts['vscode:prepublish'], undefined)
  assert.match(manifest.scripts['vscode:package'], /^npm run compile && /)
  assert.match(manifest.scripts['vscode:publish'], /^npm run compile && /)
})

test('profiles sidebar view container is contributed', () => {
  const activitybar = manifest.contributes.viewsContainers.activitybar
  assert.deepEqual(activitybar, [
    {
      id: 'codex-switch',
      title: '%view.container.title%',
      icon: 'resources/sidebar-icon.svg',
    },
  ])

  assert.deepEqual(manifest.contributes.views['codex-switch'], [
    {
      id: 'codexSwitchProfiles',
      name: '%view.profiles.name%',
      icon: 'resources/sidebar-icon.svg',
      showCollapseAll: true,
    },
  ])
})

test('profiles sidebar view title exposes the expected commands', () => {
  const titleMenus = manifest.contributes.menus['view/title'] ?? []
  const commands = titleMenus
    .filter(
      (item) =>
        typeof item.when === 'string' &&
        item.when.includes('view == codexSwitchProfiles'),
    )
    .map((item) => item.command)

  assert.deepEqual(commands, [
    'codex-switch.profile.manage',
    'codex-switch.profile.enableWorkspaceSpecificCodexHome',
    'codex-switch.profile.disableWorkspaceSpecificCodexHome',
    'codex-switch.profile.copyWorkspaceCodexHome',
    'codex-switch.reloadWindow',
    'codex-switch.profile.addFromFile',
    'codex-switch.profile.addFromCodexAuthFile',
    'codex-switch.profile.refreshAll',
    'codex-switch.profile.expandAll',
    'codex-switch.profile.exportSettings',
  ])
})

test('profiles sidebar commands use native action icons', () => {
  const expectedIcons = new Map([
    ['codex-switch.profile.manage', '$(settings-gear)'],
    ['codex-switch.profile.enableWorkspaceSpecificCodexHome', '$(check)'],
    ['codex-switch.profile.disableWorkspaceSpecificCodexHome', '$(circle-slash)'],
    ['codex-switch.profile.copyWorkspaceCodexHome', '$(copy)'],
    ['codex-switch.reloadWindow', '$(debug-restart)'],
    ['codex-switch.profile.addFromFile', '$(folder-opened)'],
    ['codex-switch.profile.addFromCodexAuthFile', '$(add)'],
    ['codex-switch.profile.refreshAll', '$(refresh)'],
    ['codex-switch.profile.expandAll', '$(expand-all)'],
    ['codex-switch.profile.exportSettings', '$(export)'],
    ['codex-switch.profile.activate', '$(arrow-swap)'],
    ['codex-switch.profile.rename', '$(edit)'],
    ['codex-switch.profile.delete', '$(trash)'],
    ['codex-switch.profile.copyValue', '$(copy)'],
  ])

  for (const [command, icon] of expectedIcons) {
    const contribution = getCommandContribution(command)
    assert.equal(contribution?.category, 'Codex Switch')
    assert.equal(contribution?.icon, icon)
  }
})

test('profile item context menu exposes switch and refresh actions', () => {
  const contextMenus = manifest.contributes.menus['view/item/context'] ?? []
  const rootRefreshActions = contextMenus
    .filter(
      (item) =>
        item.when === 'view == codexSwitchProfiles && viewItem == profileItem',
    )
    .filter(
      (item) =>
        typeof item.group === 'string' && item.group.startsWith('refresh@'),
    )
    .map((item) => item.command)

  assert.deepEqual(rootRefreshActions, [
    'codex-switch.profile.refreshQuota',
    'codex-switch.profile.refreshToken',
  ])

  const rootContextActions = contextMenus
    .filter(
      (item) =>
        item.when === 'view == codexSwitchProfiles && viewItem == profileItem',
    )
    .filter(
      (item) =>
        typeof item.group === 'string' &&
        (item.group.startsWith('inline@') || item.group.startsWith('context@')),
    )
    .map((item) => item.command)

  assert.deepEqual(rootContextActions, [
    'codex-switch.profile.activate',
    'codex-switch.profile.refreshToken',
    'codex-switch.profile.rename',
    'codex-switch.profile.delete',
  ])

  const copyAction = contextMenus.find(
    (item) =>
      item.command === 'codex-switch.profile.copyValue' &&
      item.when ===
        'view == codexSwitchProfiles && viewItem == profileCopyableField',
  )
  assert.equal(copyAction?.group, 'context@1')
})

test('workspace-specific CODEX_HOME setting is contributed', () => {
  const setting =
    manifest.contributes.configuration.properties[
      'codexSwitch.workspaceSpecificCodexHome'
    ]

  assert.equal(setting?.type, 'boolean')
  assert.equal(setting?.default, true)
  assert.equal(setting?.scope, 'window')
})

test('quota refresh interval setting is contributed', () => {
  const setting =
    manifest.contributes.configuration.properties[
      'codexSwitch.quotaRefreshInterval'
    ]

  assert.equal(setting?.type, 'number')
  assert.equal(setting?.default, 300)
  assert.equal(setting?.minimum, 60)
})

test('token auto-renew settings are contributed', () => {
  const autoRenewSetting =
    manifest.contributes.configuration.properties['codexSwitch.autoRenewTokens']
  const intervalSetting =
    manifest.contributes.configuration.properties[
      'codexSwitch.tokenAutoRenewIntervalMinutes'
    ]

  assert.equal(autoRenewSetting?.type, 'boolean')
  assert.equal(autoRenewSetting?.default, true)
  assert.equal(intervalSetting?.type, 'number')
  assert.equal(intervalSetting?.default, 60)
  assert.equal(intervalSetting?.minimum, 5)
})

test('legacy isolated workspace contributions are removed from the manifest', () => {
  assert.equal(
    getCommandContribution('codex-switch.runtime.relaunchIsolatedWindow'),
    undefined,
  )
  assert.equal(
    manifest.contributes.configuration.properties[
      'codexSwitch.activeProfileScope'
    ],
    undefined,
  )
  assert.equal(
    manifest.contributes.configuration.properties[
      'codexSwitch.runtimeIsolationMode'
    ],
    undefined,
  )
})

test('renew token command keeps the existing command id', () => {
  const contribution = getCommandContribution(
    'codex-switch.profile.refreshToken',
  )

  assert.equal(contribution?.title, '%command.profile.refreshToken.title%')
  assert.equal(contribution?.icon, '$(refresh)')
})

test('status bar click behavior includes bestQuota', () => {
  const setting =
    manifest.contributes.configuration.properties[
      'codexSwitch.statusBarClickBehavior'
    ]

  assert.deepEqual(setting?.enum, ['cycle', 'toggleLast', 'bestQuota'])
  assert.equal(
    setting?.enumDescriptions?.[2],
    '%configuration.statusBarClickBehavior.bestQuota%',
  )
})

test('status bar switch trigger includes doubleClick', () => {
  const setting =
    manifest.contributes.configuration.properties[
      'codexSwitch.statusBarSwitchTrigger'
    ]

  assert.deepEqual(setting?.enum, ['click', 'doubleClick'])
  assert.equal(setting?.default, 'click')
  assert.equal(
    setting?.enumDescriptions?.[1],
    '%configuration.statusBarSwitchTrigger.doubleClick%',
  )
})
