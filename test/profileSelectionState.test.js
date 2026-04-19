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

test('workspace-scoped active profile state migrates into global state', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-state-migration-'),
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
        'workspace-owned',
        createAuthData('workspace@example.com'),
      )

      // Migration note:
      // Previous versions allowed the active profile selection to live in
      // workspaceState when isolated runtime mode was enabled. The upgrade path
      // now consolidates that value into globalState so removing isolated
      // runtime support does not silently drop the active profile choice.
      await context.workspaceState.update(
        'codexSwitch.activeProfileId',
        profile.id,
      )
      fs.mkdirSync(codexHome, { recursive: true })
      fs.writeFileSync(
        path.join(codexHome, 'auth.json'),
        buildCodexAuthJson(createAuthData('workspace@example.com')),
        'utf8',
      )

      assert.equal(await profileManager.getActiveProfileId(), profile.id)
      assert.equal(
        context.globalState.get('codexSwitch.activeProfileId'),
        profile.id,
      )
      assert.equal(
        context.workspaceState.get('codexSwitch.activeProfileId'),
        undefined,
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

test('workspace-scoped last profile state migrates into global state', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-last-state-migration-'),
  )
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  await withMockedVscode(createVscodeMock(), async () => {
    const { ProfileManager } = require('../out/auth/profile-manager.js')
    const context = createExtensionContext(globalStoragePath)
    const profileManager = new ProfileManager(context)

    // Migration note:
    // The "last profile" pointer powers toggle behavior, so it needs the same
    // upgrade path as the active profile state when retiring workspace-scoped
    // persistence.
    await context.workspaceState.update(
      'codexSwitch.lastProfileId',
      'workspace-last-profile',
    )

    assert.equal(
      await profileManager.getLastProfileId(),
      'workspace-last-profile',
    )
    assert.equal(
      context.globalState.get('codexSwitch.lastProfileId'),
      'workspace-last-profile',
    )
    assert.equal(
      context.workspaceState.get('codexSwitch.lastProfileId'),
      undefined,
    )
  })
})
