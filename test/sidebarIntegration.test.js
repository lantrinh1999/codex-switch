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

function createVscodeMock(options = {}) {
  const registeredCommands = new Map()
  const executedCommands = []
  const clipboardWrites = []
  const informationMessages = []
  const warningMessages = []
  const errorMessages = []
  const configurationUpdates = []
  const configurationValues = new Map([
    ['codexSwitch.storageMode', options.storageMode ?? 'secretStorage'],
    ['codexSwitch.reloadWindowAfterProfileSwitch', false],
    [
      'codexSwitch.statusBarClickBehavior',
      options.statusBarClickBehavior ?? 'cycle',
    ],
    [
      'codexSwitch.statusBarSwitchTrigger',
      options.statusBarSwitchTrigger ?? 'click',
    ],
    [
      'codexSwitch.workspaceSpecificCodexHome',
      options.workspaceSpecificCodexHome ?? true,
    ],
    ['chatgpt.runCodexInWindowsSubsystemForLinux', false],
  ])

  return {
    registeredCommands,
    executedCommands,
    clipboardWrites,
    informationMessages,
    warningMessages,
    errorMessages,
    configurationUpdates,
    configurationValues,
    l10n: {
      t(message, ...args) {
        return message.replace(/\{(\d+)\}/g, (_, index) =>
          String(args[Number(index)] ?? ''),
        )
      },
    },
    env: {
      clipboard: {
        async writeText(value) {
          clipboardWrites.push(value)
          await options.onClipboardWrite?.(value)
        },
      },
      remoteName: undefined,
    },
    Uri: {
      file(fsPath) {
        return { fsPath }
      },
    },
    workspace: {
      workspaceFolders: options.workspaceFolders,
      workspaceFile: options.workspaceFile,
      getConfiguration(section) {
        return {
          get(key, defaultValue) {
            const configKey = `${section}.${key}`
            if (configurationValues.has(configKey)) {
              return configurationValues.get(configKey)
            }
            return defaultValue
          },
          async update(key, value, target) {
            const configKey = `${section}.${key}`
            configurationValues.set(configKey, value)
            configurationUpdates.push({ section, key, value, target })
          },
          has() {
            return false
          },
        }
      },
    },
    window: {
      async showInformationMessage(message) {
        informationMessages.push(message)
        return options.showInformationMessageResult
      },
      async showWarningMessage(message) {
        warningMessages.push(message)
        return options.showWarningMessageResult
      },
      async showErrorMessage(message) {
        errorMessages.push(message)
        return undefined
      },
      async showQuickPick() {
        return options.showQuickPickResult
      },
      async showInputBox() {
        return options.showInputBoxResult
      },
      async showOpenDialog() {
        return undefined
      },
      async showSaveDialog() {
        return undefined
      },
    },
    commands: {
      registerCommand(command, callback) {
        registeredCommands.set(command, callback)
        return {
          dispose() {
            registeredCommands.delete(command)
          },
        }
      },
      async executeCommand(command, ...args) {
        executedCommands.push({ command, args })
        const callback = registeredCommands.get(command)
        if (!callback) {
          return undefined
        }
        return callback(...args)
      },
    },
    RelativePattern: class RelativePattern {
      constructor(base, pattern) {
        this.base = base
        this.pattern = pattern
      }
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

test('add from current auth imports the workspace runtime auth file', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-sidebar-workspace-auth-'),
  )
  const globalCodexHome = path.join(tempDir, 'global-codex-home')
  const workspaceStoragePath = path.join(tempDir, 'workspace-storage')
  const globalStoragePath = path.join(tempDir, 'storage')
  const workspaceCodexHome = path.join(workspaceStoragePath, '.codex')
  fs.mkdirSync(globalStoragePath, { recursive: true })
  fs.mkdirSync(globalCodexHome, { recursive: true })
  fs.mkdirSync(workspaceCodexHome, { recursive: true })

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = globalCodexHome

  const vscodeMock = createVscodeMock({
    showInputBoxResult: 'workspace-imported',
  })
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: globalStoragePath },
    storageUri: { fsPath: workspaceStoragePath },
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

  try {
    await withMockedVscode(vscodeMock, async () => {
      const { buildCodexAuthJson } = require('../out/auth/codex-auth-sync.js')
      const { ProfileManager } = require('../out/auth/profile-manager.js')
      const { registerCommands } = require('../out/commands/index.js')

      const globalAuthData = {
        idToken: makeJwt({
          email: 'global@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
        }),
        accessToken: makeJwt({
          exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
        }),
        refreshToken: 'refresh-global',
        email: 'global@example.com',
        planType: 'plus',
        authJson: {
          tokens: { id_token: '', access_token: '', refresh_token: '' },
        },
      }
      const workspaceAuthData = {
        idToken: makeJwt({
          email: 'workspace@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
        }),
        accessToken: makeJwt({
          exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
        }),
        refreshToken: 'refresh-workspace',
        email: 'workspace@example.com',
        planType: 'plus',
        authJson: {
          tokens: { id_token: '', access_token: '', refresh_token: '' },
        },
      }

      fs.writeFileSync(
        path.join(globalCodexHome, 'auth.json'),
        buildCodexAuthJson(globalAuthData),
        'utf8',
      )
      fs.writeFileSync(
        path.join(workspaceCodexHome, 'auth.json'),
        buildCodexAuthJson(workspaceAuthData),
        'utf8',
      )

      const profileManager = new ProfileManager(context)
      registerCommands(context, profileManager, {
        async refreshUi() {},
        async refreshAll() {},
        async refreshQuota() {},
        async refreshToken() {
          return true
        },
      })

      await vscodeMock.commands.executeCommand(
        'codex-switch.profile.addFromCodexAuthFile',
      )

      const profiles = await profileManager.listProfiles()
      assert.equal(profiles.length, 1)
      assert.equal(profiles[0].name, 'workspace-imported')
      assert.equal(profiles[0].email, 'workspace@example.com')

      const activeAuthJson = JSON.parse(
        fs.readFileSync(path.join(workspaceCodexHome, 'auth.json'), 'utf8'),
      )
      assert.equal(activeAuthJson.tokens.refresh_token, 'refresh-workspace')
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('sidebar activate command switches the active profile and syncs auth.json', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-sidebar-test-'),
  )
  const codexHome = path.join(tempDir, 'codex-home')
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  const vscodeMock = createVscodeMock()
  const context = {
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

  try {
    await withMockedVscode(vscodeMock, async () => {
      const profileManagerModule = require('../out/auth/profile-manager.js')
      const commandsModule = require('../out/commands/index.js')
      const { ProfileManager } = profileManagerModule
      const { registerCommands } = commandsModule

      const profileManager = new ProfileManager(context)
      const refreshCalls = []
      const refreshCoordinator = {
        async refreshUi() {
          refreshCalls.push('ui')
        },
        async refreshAll() {},
        async refreshQuota(profileId) {
          refreshCalls.push(['quota', profileId])
        },
        async refreshToken() {
          return true
        },
      }

      registerCommands(context, profileManager, refreshCoordinator)

      const authData = {
        idToken: makeJwt({
          email: 'sidebar@example.com',
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'plus',
          },
        }),
        accessToken: makeJwt({
          exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
        }),
        refreshToken: 'refresh-token',
        email: 'sidebar@example.com',
        planType: 'plus',
        authJson: {
          tokens: {
            id_token: '',
            access_token: '',
            refresh_token: '',
          },
        },
      }

      const profile = await profileManager.createProfile('sidebar', authData)

      await vscodeMock.commands.executeCommand(
        'codex-switch.profile.activate',
        { profileId: profile.id },
      )

      assert.equal(await profileManager.getActiveProfileId(), profile.id)

      const authPath = path.join(codexHome, 'auth.json')
      const authJson = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      assert.equal(authJson.tokens.access_token, authData.accessToken)
      assert.equal(authJson.tokens.refresh_token, authData.refreshToken)

      assert.deepEqual(refreshCalls, ['ui', ['quota', profile.id]])
      assert.deepEqual(vscodeMock.informationMessages, [
        'Switched to profile "sidebar".',
      ])
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('status bar bestQuota behavior switches to the profile with the most remaining quota', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-best-quota-test-'),
  )
  const codexHome = path.join(tempDir, 'codex-home')
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  const vscodeMock = createVscodeMock({ statusBarClickBehavior: 'bestQuota' })
  const context = {
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

  try {
    await withMockedVscode(vscodeMock, async () => {
      const profileManagerModule = require('../out/auth/profile-manager.js')
      const commandsModule = require('../out/commands/index.js')
      const { ProfileManager } = profileManagerModule
      const { registerCommands } = commandsModule

      const profileManager = new ProfileManager(context)
      const profileA = await profileManager.createProfile('low', {
        idToken: makeJwt({
          email: 'low@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
        }),
        accessToken: makeJwt({
          exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
        }),
        refreshToken: 'refresh-low',
        email: 'low@example.com',
        planType: 'plus',
        authJson: {
          tokens: { id_token: '', access_token: '', refresh_token: '' },
        },
      })
      const profileB = await profileManager.createProfile('high', {
        idToken: makeJwt({
          email: 'high@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
        }),
        accessToken: makeJwt({
          exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
        }),
        refreshToken: 'refresh-high',
        email: 'high@example.com',
        planType: 'plus',
        authJson: {
          tokens: { id_token: '', access_token: '', refresh_token: '' },
        },
      })

      await profileManager.setActiveProfileId(profileA.id)

      const refreshCalls = []
      const refreshCoordinator = {
        async refreshUi() {
          refreshCalls.push('ui')
        },
        async refreshAll() {},
        async refreshQuota(profileId) {
          refreshCalls.push(['quota', profileId])
        },
        async refreshToken() {
          return true
        },
        getHealthStates() {
          return new Map([
            [
              profileA.id,
              {
                quotaInfo: {
                  primaryWindow: { remainingPercent: 30 },
                  secondaryWindow: { remainingPercent: 40 },
                },
              },
            ],
            [
              profileB.id,
              {
                quotaInfo: {
                  primaryWindow: { remainingPercent: 80 },
                  secondaryWindow: { remainingPercent: 70 },
                },
              },
            ],
          ])
        },
      }

      registerCommands(context, profileManager, refreshCoordinator)

      await vscodeMock.commands.executeCommand(
        'codex-switch.profile.toggleLast',
      )

      assert.equal(await profileManager.getActiveProfileId(), profileB.id)
      assert.deepEqual(refreshCalls, [
        ['quota', undefined],
        'ui',
        ['quota', profileB.id],
      ])
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('status bar double-click trigger waits for the second click before switching', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-status-bar-double-click-test-'),
  )
  const codexHome = path.join(tempDir, 'codex-home')
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  const vscodeMock = createVscodeMock({ statusBarSwitchTrigger: 'doubleClick' })
  const context = {
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

  try {
    await withMockedVscode(vscodeMock, async () => {
      const profileManagerModule = require('../out/auth/profile-manager.js')
      const commandsModule = require('../out/commands/index.js')
      const { ProfileManager } = profileManagerModule
      const { registerCommands } = commandsModule

      const profileManager = new ProfileManager(context)
      const refreshCalls = []
      const refreshCoordinator = {
        async refreshUi() {
          refreshCalls.push('ui')
        },
        async refreshAll() {},
        async refreshQuota(profileId) {
          refreshCalls.push(['quota', profileId])
        },
        async refreshToken() {
          return true
        },
      }

      registerCommands(context, profileManager, refreshCoordinator)

      const profileA = await profileManager.createProfile('first', {
        idToken: makeJwt({
          email: 'first@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
        }),
        accessToken: makeJwt({
          exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
        }),
        refreshToken: 'refresh-first',
        email: 'first@example.com',
        planType: 'plus',
        authJson: {
          tokens: { id_token: '', access_token: '', refresh_token: '' },
        },
      })
      const profileB = await profileManager.createProfile('second', {
        idToken: makeJwt({
          email: 'second@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
        }),
        accessToken: makeJwt({
          exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
        }),
        refreshToken: 'refresh-second',
        email: 'second@example.com',
        planType: 'plus',
        authJson: {
          tokens: { id_token: '', access_token: '', refresh_token: '' },
        },
      })

      await profileManager.setActiveProfileId(profileA.id)

      await vscodeMock.commands.executeCommand(
        'codex-switch.profile.statusBarAction',
      )
      assert.equal(await profileManager.getActiveProfileId(), profileA.id)
      assert.deepEqual(refreshCalls, [])

      await vscodeMock.commands.executeCommand(
        'codex-switch.profile.statusBarAction',
      )
      assert.equal(await profileManager.getActiveProfileId(), profileB.id)
      assert.deepEqual(refreshCalls, ['ui', ['quota', profileB.id]])
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('status bar double-click can recover from no-auth by activating a saved profile', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-status-bar-no-auth-double-click-'),
  )
  const codexHome = path.join(tempDir, 'codex-home')
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  const vscodeMock = createVscodeMock({ statusBarSwitchTrigger: 'doubleClick' })
  const context = {
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

  try {
    await withMockedVscode(vscodeMock, async () => {
      const profileManagerModule = require('../out/auth/profile-manager.js')
      const commandsModule = require('../out/commands/index.js')
      const { ProfileManager } = profileManagerModule
      const { registerCommands } = commandsModule

      const profileManager = new ProfileManager(context)
      const refreshCalls = []
      registerCommands(context, profileManager, {
        async refreshUi() {
          refreshCalls.push('ui')
        },
        async refreshAll() {},
        async refreshQuota(profileId) {
          refreshCalls.push(['quota', profileId])
        },
        async refreshToken() {
          return true
        },
      })

      const profile = await profileManager.createProfile('recover-me', {
        idToken: makeJwt({
          email: 'recover@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
        }),
        accessToken: makeJwt({
          exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
        }),
        refreshToken: 'refresh-recover',
        email: 'recover@example.com',
        planType: 'plus',
        authJson: {
          tokens: { id_token: '', access_token: '', refresh_token: '' },
        },
      })

      assert.equal(await profileManager.getActiveProfileId(), undefined)

      await vscodeMock.commands.executeCommand(
        'codex-switch.profile.statusBarAction',
      )
      assert.equal(await profileManager.getActiveProfileId(), undefined)
      assert.deepEqual(refreshCalls, [])

      await vscodeMock.commands.executeCommand(
        'codex-switch.profile.statusBarAction',
      )
      assert.equal(await profileManager.getActiveProfileId(), profile.id)
      assert.deepEqual(refreshCalls, ['ui', ['quota', profile.id]])
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('renew token command works for a direct profile target and refreshes quota', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-renew-token-direct-test-'),
  )
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const vscodeMock = createVscodeMock()
  const context = {
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

  await withMockedVscode(vscodeMock, async () => {
    const profileManagerModule = require('../out/auth/profile-manager.js')
    const commandsModule = require('../out/commands/index.js')
    const { ProfileManager } = profileManagerModule
    const { registerCommands } = commandsModule

    const profileManager = new ProfileManager(context)
    const profile = await profileManager.createProfile('renew-me', {
      idToken: makeJwt({
        email: 'renew@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
      }),
      accessToken: makeJwt({
        exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
      }),
      refreshToken: 'refresh-renew',
      email: 'renew@example.com',
      planType: 'plus',
      authJson: {
        tokens: { id_token: '', access_token: '', refresh_token: '' },
      },
    })

    const calls = []
    registerCommands(context, profileManager, {
      async refreshUi() {},
      async refreshAll() {},
      async refreshQuota(profileId) {
        calls.push(['quota', profileId])
      },
      async refreshToken(profileId) {
        calls.push(['renew', profileId])
        return true
      },
    })

    await vscodeMock.commands.executeCommand(
      'codex-switch.profile.refreshToken',
      { profileId: profile.id },
    )

    assert.deepEqual(calls, [
      ['renew', profile.id],
      ['quota', profile.id],
    ])
    assert.deepEqual(vscodeMock.informationMessages, [
      'Renewed token for "renew".',
    ])
  })
})

test('renew token command falls back to the picker when no target is provided', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-renew-token-picker-test-'),
  )
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const vscodeMock = createVscodeMock({
    showQuickPickResult: {
      label: 'picked-profile',
      profileId: 'profile-picked',
    },
  })
  const context = {
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

  await withMockedVscode(vscodeMock, async () => {
    const profileManagerModule = require('../out/auth/profile-manager.js')
    const commandsModule = require('../out/commands/index.js')
    const { ProfileManager } = profileManagerModule
    const { registerCommands } = commandsModule

    const profileManager = new ProfileManager(context)
    await profileManager.createProfile('picked-profile', {
      idToken: makeJwt({
        email: 'picked@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
      }),
      accessToken: makeJwt({
        exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
      }),
      refreshToken: 'refresh-picked',
      email: 'picked@example.com',
      planType: 'plus',
      authJson: {
        tokens: { id_token: '', access_token: '', refresh_token: '' },
      },
    })

    const calls = []
    registerCommands(context, profileManager, {
      async refreshUi() {},
      async refreshAll() {},
      async refreshQuota(profileId) {
        calls.push(['quota', profileId])
      },
      async refreshToken(profileId) {
        calls.push(['renew', profileId])
        return true
      },
    })

    await vscodeMock.commands.executeCommand(
      'codex-switch.profile.refreshToken',
    )

    assert.deepEqual(calls, [
      ['renew', 'profile-picked'],
      ['quota', 'profile-picked'],
    ])
    assert.deepEqual(vscodeMock.informationMessages, [
      'Renewed token for "picked-profile".',
    ])
  })
})

test('refresh quota command notifies after a direct profile refresh', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-refresh-quota-direct-test-'),
  )
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const vscodeMock = createVscodeMock()
  const context = {
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

  await withMockedVscode(vscodeMock, async () => {
    const profileManagerModule = require('../out/auth/profile-manager.js')
    const commandsModule = require('../out/commands/index.js')
    const { ProfileManager } = profileManagerModule
    const { registerCommands } = commandsModule

    const profileManager = new ProfileManager(context)
    const profile = await profileManager.createProfile('quota-me', {
      idToken: makeJwt({
        email: 'quota@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
      }),
      accessToken: makeJwt({
        exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
      }),
      refreshToken: 'refresh-quota',
      email: 'quota@example.com',
      planType: 'plus',
      authJson: {
        tokens: { id_token: '', access_token: '', refresh_token: '' },
      },
    })

    const calls = []
    registerCommands(context, profileManager, {
      async refreshUi() {},
      async refreshAll() {},
      async refreshQuota(profileId) {
        calls.push(['quota', profileId])
      },
      async refreshToken() {
        return true
      },
    })

    await vscodeMock.commands.executeCommand(
      'codex-switch.profile.refreshQuota',
      { profileId: profile.id },
    )

    assert.deepEqual(calls, [['quota', profile.id]])
    assert.deepEqual(vscodeMock.informationMessages, [
      'Refreshed quota for "quota".',
    ])
  })
})

test('copy workspace CODEX_HOME command copies the workspace-specific path', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-copy-workspace-codex-home-'),
  )
  const workspaceStoragePath = path.join(tempDir, 'workspace-storage')
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(workspaceStoragePath, { recursive: true })
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const vscodeMock = createVscodeMock()
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: globalStoragePath },
    storageUri: { fsPath: workspaceStoragePath },
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

  await withMockedVscode(vscodeMock, async () => {
    const profileManagerModule = require('../out/auth/profile-manager.js')
    const commandsModule = require('../out/commands/index.js')
    const { ProfileManager } = profileManagerModule
    const { registerCommands } = commandsModule

    const profileManager = new ProfileManager(context)
    registerCommands(context, profileManager, {
      async refreshUi() {},
      async refreshAll() {},
      async refreshQuota() {},
      async refreshToken() {
        return true
      },
    })

    await vscodeMock.commands.executeCommand(
      'codex-switch.profile.copyWorkspaceCodexHome',
    )

    const expectedPath = path.join(workspaceStoragePath, '.codex')
    assert.deepEqual(vscodeMock.clipboardWrites, [expectedPath])
    assert.deepEqual(vscodeMock.informationMessages, [
      `Copied workspace CODEX_HOME to clipboard: ${expectedPath}`,
    ])
    assert.deepEqual(vscodeMock.errorMessages, [])
  })
})

test('workspace-specific CODEX_HOME panel commands update the workspace setting', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-toggle-workspace-codex-home-'),
  )
  const workspaceStoragePath = path.join(tempDir, 'workspace-storage')
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(workspaceStoragePath, { recursive: true })
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const vscodeMock = createVscodeMock({
    workspaceFolders: [{ uri: { fsPath: workspaceStoragePath } }],
  })
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: globalStoragePath },
    storageUri: { fsPath: workspaceStoragePath },
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

  await withMockedVscode(vscodeMock, async () => {
    const profileManagerModule = require('../out/auth/profile-manager.js')
    const commandsModule = require('../out/commands/index.js')
    const { ProfileManager } = profileManagerModule
    const { registerCommands } = commandsModule

    const profileManager = new ProfileManager(context)
    registerCommands(context, profileManager, {
      async refreshUi() {},
      async refreshAll() {},
      async refreshQuota() {},
      async refreshToken() {
        return true
      },
    })

    await vscodeMock.commands.executeCommand(
      'codex-switch.profile.disableWorkspaceSpecificCodexHome',
    )
    await vscodeMock.commands.executeCommand(
      'codex-switch.profile.enableWorkspaceSpecificCodexHome',
    )

    assert.deepEqual(vscodeMock.configurationUpdates, [
      {
        section: 'codexSwitch',
        key: 'workspaceSpecificCodexHome',
        value: false,
        target: false,
      },
      {
        section: 'codexSwitch',
        key: 'workspaceSpecificCodexHome',
        value: true,
        target: false,
      },
    ])
    assert.equal(
      vscodeMock.configurationValues.get(
        'codexSwitch.workspaceSpecificCodexHome',
      ),
      true,
    )
    assert.deepEqual(vscodeMock.informationMessages.slice(-2), [
      'Disabled workspace-specific CODEX_HOME.',
      'Enabled workspace-specific CODEX_HOME.',
    ])
  })
})

test('expand all command reveals every profile root item', async () => {
  const vscodeMock = createVscodeMock()
  const context = { subscriptions: [] }

  await withMockedVscode(vscodeMock, async () => {
    const commandsModule = require('../out/commands/index.js')
    const { registerCommands } = commandsModule
    const rootItems = [{ id: 'one' }, { id: 'two' }]
    const revealCalls = []

    registerCommands(
      context,
      {},
      {},
      {
        getRootItems() {
          return rootItems
        },
      },
      {
        async reveal(item, options) {
          revealCalls.push({ item, options })
        },
      },
    )

    await vscodeMock.commands.executeCommand('codex-switch.profile.expandAll')

    assert.deepEqual(revealCalls, [
      {
        item: rootItems[0],
        options: { expand: true, focus: false, select: false },
      },
      {
        item: rootItems[1],
        options: { expand: true, focus: false, select: false },
      },
    ])
  })
})
