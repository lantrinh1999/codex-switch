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
    values,
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

function createVscodeMock() {
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
      getConfiguration() {
        return {
          get(key, defaultValue) {
            if (key === 'storageMode') {
              return 'secretStorage'
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

test('active profile selection is stored per-workspace in workspaceState', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-ws-active-'),
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
        'workspace-owned',
        createAuthData('workspace@example.com'),
      )

      fs.mkdirSync(codexHome, { recursive: true })

      // setActiveProfileId should write to workspaceState (per-window) and
      // NOT touch globalState, ensuring each VS Code window is isolated.
      await profileManager.setActiveProfileId(profile.id)

      assert.equal(
        context.workspaceState.get('codexSwitch.activeProfileId'),
        profile.id,
        'active profile must be stored in workspaceState for per-window isolation',
      )
      assert.equal(
        context.globalState.get('codexSwitch.activeProfileId'),
        undefined,
        'globalState must not be written when saving per-window profile selection',
      )
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('global state active profile migrates to workspaceState for per-window isolation', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-global-migrate-'),
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
      const profile = await profileManager.createProfile(
        'global-owned',
        createAuthData('global@example.com'),
      )

      // Simulate state written by an older extension version (which used globalState).
      await context.globalState.update(
        'codexSwitch.activeProfileId',
        profile.id,
      )
      fs.mkdirSync(codexHome, { recursive: true })
      fs.writeFileSync(
        path.join(codexHome, 'auth.json'),
        buildCodexAuthJson(createAuthData('global@example.com')),
        'utf8',
      )

      assert.equal(await profileManager.getActiveProfileId(), profile.id)

      // The value should be promoted to workspaceState so this window is now isolated.
      assert.equal(
        context.workspaceState.get('codexSwitch.activeProfileId'),
        profile.id,
        'global state value must be migrated to workspaceState',
      )
      // globalState is left intact so other workspace windows can also migrate.
      assert.equal(
        context.globalState.get('codexSwitch.activeProfileId'),
        profile.id,
        'globalState must remain for other windows to migrate from',
      )
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('last profile selection is stored per-workspace in workspaceState', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-ws-last-'),
  )
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  await withMockedVscode(createVscodeMock(), async () => {
    const { ProfileManager } = require('../out/auth/profile-manager.js')
    const context = createExtensionContext(globalStoragePath)
    const profileManager = new ProfileManager(context)

    // Simulate a direct workspaceState write (as the extension now does).
    await context.workspaceState.update(
      'codexSwitch.lastProfileId',
      'workspace-last-profile',
    )

    assert.equal(
      await profileManager.getLastProfileId(),
      'workspace-last-profile',
      'last profile must be read from workspaceState',
    )
    assert.equal(
      context.globalState.get('codexSwitch.lastProfileId'),
      undefined,
      'globalState must not be written for the last profile pointer',
    )
    assert.equal(
      context.workspaceState.get('codexSwitch.lastProfileId'),
      'workspace-last-profile',
      'workspaceState must retain the last profile value',
    )
  })
})
