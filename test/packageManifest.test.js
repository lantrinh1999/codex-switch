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
    .filter((item) => item.when === 'view == codexSwitchProfiles')
    .map((item) => item.command)

  assert.deepEqual(commands, [
    'codex-switch.profile.manage',
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
  const rootActions = contextMenus
    .filter(
      (item) =>
        item.when === 'view == codexSwitchProfiles && viewItem == profileItem',
    )
    .map((item) => item.command)

  assert.deepEqual(rootActions, [
    'codex-switch.profile.activate',
    'codex-switch.profile.refreshQuota',
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

test('quota refresh interval setting is contributed', () => {
  const setting =
    manifest.contributes.configuration.properties[
      'codexSwitch.quotaRefreshInterval'
    ]

  assert.equal(setting?.type, 'number')
  assert.equal(setting?.default, 300)
  assert.equal(setting?.minimum, 60)
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
