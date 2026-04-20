const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

function makeJwt(payload) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' }),
  ).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.`
}

function createAuthData(email, refreshToken = 'refresh-token') {
  return {
    idToken: makeJwt({
      email,
      sub: email,
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'plus',
      },
    }),
    accessToken: makeJwt({
      exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
    }),
    refreshToken,
    email,
    planType: 'plus',
    authJson: {
      tokens: {
        id_token: '',
        access_token: '',
        refresh_token: '',
      },
    },
  }
}

function createMemento() {
  const values = new Map()
  return {
    get(key) {
      return values.get(key)
    },
    async update(key, value) {
      if (typeof value === 'undefined') {
        values.delete(key)
        return
      }
      values.set(key, value)
    },
  }
}

function createExtensionContext(globalStoragePath) {
  return {
    subscriptions: [],
    globalStorageUri: { fsPath: globalStoragePath },
    secrets: {
      values: new Map(),
      async get(key) {
        return this.values.get(key)
      },
      async store(key, value) {
        this.values.set(key, value)
      },
      async delete(key) {
        this.values.delete(key)
      },
    },
    globalState: createMemento(),
    workspaceState: createMemento(),
  }
}

function createStatusBarMock() {
  return {
    text: '',
    command: undefined,
    tooltip: undefined,
    show() {},
    dispose() {},
  }
}

function createVscodeMock(options = {}) {
  return {
    l10n: {
      t(message, ...args) {
        return message.replace(/\{(\d+)\}/g, (_, index) =>
          String(args[Number(index)] ?? ''),
        )
      },
    },
    env: {
      remoteName: undefined,
    },
    workspace: {
      getConfiguration(section) {
        return {
          get(key, defaultValue) {
            if (section === 'codexSwitch' && key === 'storageMode') {
              return options.storageMode ?? 'secretStorage'
            }
            return defaultValue
          },
          has() {
            return false
          },
        }
      },
    },
    window: {
      async showWarningMessage() {
        return undefined
      },
      async showInformationMessage() {
        return undefined
      },
      async showErrorMessage() {
        return undefined
      },
      createStatusBarItem() {
        return createStatusBarMock()
      },
    },
    MarkdownString: class MarkdownString {
      constructor() {
        this.value = ''
      }

      appendMarkdown(value) {
        this.value += value
      }
    },
    StatusBarAlignment: {
      Right: 2,
    },
    TreeItem: class TreeItem {
      constructor(label, collapsibleState) {
        this.label = label
        this.collapsibleState = collapsibleState
      }
    },
    EventEmitter: class EventEmitter {
      constructor() {
        this.listeners = new Set()
        this.event = (listener) => {
          this.listeners.add(listener)
          return {
            dispose: () => this.listeners.delete(listener),
          }
        }
      }

      fire(value) {
        for (const listener of this.listeners) {
          listener(value)
        }
      }

      dispose() {
        this.listeners.clear()
      }
    },
    ThemeIcon: class ThemeIcon {
      constructor(id, color) {
        this.id = id
        this.color = color
      }
    },
    ThemeColor: class ThemeColor {
      constructor(id) {
        this.id = id
      }
    },
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
  }
}

async function withMockedVscode(vscodeMock, fn) {
  const originalLoad = Module._load
  const outRoot = `${path.sep}out${path.sep}`
  Module._load = function patched(request, parent, isMain) {
    if (request === 'vscode') {
      return vscodeMock
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    for (const cacheKey of Object.keys(require.cache)) {
      if (cacheKey.includes(outRoot)) {
        delete require.cache[cacheKey]
      }
    }
    return await fn()
  } finally {
    Module._load = originalLoad
  }
}

test('runtime session falls back to external auth when auth.json changes outside saved state', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-runtime-session-'),
  )
  const codexHome = path.join(tempDir, 'codex-home')
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  try {
    await withMockedVscode(createVscodeMock(), async () => {
      const { ProfileManager } = require('../out/auth/profile-manager.js')
      const context = createExtensionContext(globalStoragePath)
      const profileManager = new ProfileManager(context)

      const savedProfile = await profileManager.createProfile(
        'saved',
        createAuthData('saved@example.com'),
      )
      assert.equal(
        await profileManager.setActiveProfileId(savedProfile.id),
        true,
      )

      const externalAuth = createAuthData(
        'external@example.com',
        'external-refresh',
      )
      const { buildCodexAuthJson } = require('../out/auth/codex-auth-sync.js')
      fs.mkdirSync(codexHome, { recursive: true })
      fs.writeFileSync(
        path.join(codexHome, 'auth.json'),
        buildCodexAuthJson(externalAuth),
        'utf8',
      )

      const runtimeSession = await profileManager.getRuntimeSession()
      assert.equal(runtimeSession.kind, 'externalAuth')
      assert.equal(runtimeSession.authData.email, 'external@example.com')
      assert.match(
        runtimeSession.warningMessage,
        /saved active profile "saved"/i,
      )
      assert.equal(await profileManager.getActiveProfileId(), undefined)
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('runtime session restores the workspace active profile when auth.json matches another saved profile', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-runtime-restore-saved-'),
  )
  const codexHome = path.join(tempDir, 'codex-home')
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  try {
    await withMockedVscode(createVscodeMock(), async () => {
      const { ProfileManager } = require('../out/auth/profile-manager.js')
      const { buildCodexAuthJson } = require('../out/auth/codex-auth-sync.js')
      const context = createExtensionContext(globalStoragePath)
      const profileManager = new ProfileManager(context)

      const workspaceProfile = await profileManager.createProfile(
        'workspace-owner',
        createAuthData('workspace@example.com', 'refresh-workspace'),
      )
      const strayProfile = await profileManager.createProfile(
        'stray-runtime',
        createAuthData('stray@example.com', 'refresh-stray'),
      )
      assert.equal(
        await profileManager.setActiveProfileId(workspaceProfile.id),
        true,
      )

      fs.mkdirSync(codexHome, { recursive: true })
      fs.writeFileSync(
        path.join(codexHome, 'auth.json'),
        buildCodexAuthJson(await profileManager.loadAuthData(strayProfile.id)),
        'utf8',
      )

      const runtimeSession = await profileManager.getRuntimeSession()
      assert.equal(runtimeSession.kind, 'matchedProfile')
      assert.equal(runtimeSession.matchedProfileId, workspaceProfile.id)
      assert.equal(runtimeSession.authData.email, 'workspace@example.com')
      assert.equal(runtimeSession.warningMessage, undefined)
      assert.equal(
        context.workspaceState.get('codexSwitch.activeProfileId'),
        workspaceProfile.id,
      )

      const authJson = JSON.parse(
        fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'),
      )
      assert.equal(authJson.tokens.refresh_token, 'refresh-workspace')
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('runtime session recreates missing auth.json from the workspace active profile', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-runtime-restore-missing-'),
  )
  const codexHome = path.join(tempDir, 'codex-home')
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  try {
    await withMockedVscode(createVscodeMock(), async () => {
      const { ProfileManager } = require('../out/auth/profile-manager.js')
      const context = createExtensionContext(globalStoragePath)
      const profileManager = new ProfileManager(context)
      const profile = await profileManager.createProfile(
        'workspace-owner',
        createAuthData('workspace@example.com', 'refresh-workspace'),
      )

      assert.equal(await profileManager.setActiveProfileId(profile.id), true)
      fs.unlinkSync(path.join(codexHome, 'auth.json'))

      const runtimeSession = await profileManager.getRuntimeSession()
      assert.equal(runtimeSession.kind, 'matchedProfile')
      assert.equal(runtimeSession.matchedProfileId, profile.id)
      assert.equal(runtimeSession.authData.email, 'workspace@example.com')
      assert.equal(runtimeSession.warningMessage, undefined)

      const authJson = JSON.parse(
        fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'),
      )
      assert.equal(authJson.tokens.refresh_token, 'refresh-workspace')
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('deleting the saved active profile preserves runtime auth as an external session', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-runtime-delete-'),
  )
  const codexHome = path.join(tempDir, 'codex-home')
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  try {
    await withMockedVscode(createVscodeMock(), async () => {
      const { ProfileManager } = require('../out/auth/profile-manager.js')
      const context = createExtensionContext(globalStoragePath)
      const profileManager = new ProfileManager(context)
      const profile = await profileManager.createProfile(
        'runtime-owner',
        createAuthData('runtime@example.com'),
      )

      assert.equal(await profileManager.setActiveProfileId(profile.id), true)
      assert.equal(await profileManager.deleteProfile(profile.id), true)

      const runtimeSession = await profileManager.getRuntimeSession()
      assert.equal(runtimeSession.kind, 'externalAuth')
      assert.equal(runtimeSession.authData.email, 'runtime@example.com')
      assert.equal(await profileManager.getActiveProfileId(), undefined)
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('status bar and profile tree stay consistent across matched, external, and no-auth runtime states', async () => {
  await withMockedVscode(createVscodeMock(), async () => {
    const statusBarModule = require('../out/ui/status-bar.js')
    const treeModule = require('../out/ui/profile-tree.js')

    const statusBarItem = statusBarModule.createStatusBarItem()
    const treeProvider = new treeModule.ProfileTreeProvider()
    const profiles = [
      {
        id: 'profile-1',
        name: 'fangfangpremium+1',
        email: 'fangfangpremium+3@gmail.com',
        planType: 'plus',
        createdAt: '2026-04-12T00:00:00.000Z',
        updatedAt: '2026-04-12T00:00:00.000Z',
      },
    ]

    const matchedSession = {
      kind: 'matchedProfile',
      authPath: '/tmp/auth.json',
      authData: createAuthData('fangfangpremium+3@gmail.com'),
      matchedProfileId: 'profile-1',
    }
    treeProvider.setState(profiles, matchedSession, new Map())
    statusBarModule.updateProfileStatus(matchedSession, profiles)
    assert.match(statusBarItem.text, /fangfangpremium\+3/)
    assert.equal(statusBarItem.command, 'codex-switch.profile.manage')
    assert.equal(treeProvider.getRootItems().length, 1)
    assert.equal(treeProvider.getRootItems()[0].label, 'fangfangpremium+3')
    assert.match(String(treeProvider.getRootItems()[0].description), /\+1/)

    const externalSession = {
      kind: 'externalAuth',
      authPath: '/tmp/auth.json',
      authData: createAuthData('external@example.com'),
      warningMessage: 'external runtime warning',
    }
    treeProvider.setState(profiles, externalSession, new Map())
    statusBarModule.updateProfileStatus(externalSession, profiles)
    assert.match(statusBarItem.text, /external/)
    assert.equal(statusBarItem.command, 'codex-switch.profile.statusBarAction')
    assert.equal(treeProvider.getRootItems()[0].label, 'Runtime auth')
    treeProvider.setExpanded('__runtime__', true)
    treeProvider.setState(profiles, externalSession, new Map())
    assert.equal(treeProvider.getRootItems()[0].collapsibleState, 2)

    const noAuthSession = {
      kind: 'noAuth',
      authPath: '/tmp/auth.json',
      authData: null,
    }
    treeProvider.setState(profiles, noAuthSession, new Map())
    statusBarModule.updateProfileStatus(noAuthSession, profiles)
    assert.match(statusBarItem.text, /none/i)
    assert.equal(statusBarItem.command, 'codex-switch.profile.statusBarAction')
    assert.equal(treeProvider.getRootItems()[0].label, 'Runtime auth')
  })
})
