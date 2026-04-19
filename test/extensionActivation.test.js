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

function createStatusBarItem() {
  return {
    text: '',
    command: undefined,
    tooltip: undefined,
    show() {},
    dispose() {},
  }
}

function createVscodeMock() {
  const registeredCommands = new Map()

  class EventEmitter {
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
  }

  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label
      this.collapsibleState = collapsibleState
    }
  }

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
      uriScheme: 'vscode',
      appRoot: '',
      clipboard: {
        async writeText() {},
      },
    },
    Uri: {
      file(fsPath) {
        return { fsPath }
      },
    },
    RelativePattern: class RelativePattern {
      constructor(base, pattern) {
        this.base = base
        this.pattern = pattern
      }
    },
    StatusBarAlignment: {
      Right: 2,
    },
    TreeItem,
    EventEmitter,
    MarkdownString: class MarkdownString {
      constructor() {
        this.value = ''
      }

      appendMarkdown(value) {
        this.value += value
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
    window: {
      createStatusBarItem() {
        return createStatusBarItem()
      },
      createTreeView() {
        return {
          dispose() {},
          onDidExpandElement() {
            return { dispose() {} }
          },
          onDidCollapseElement() {
            return { dispose() {} }
          },
        }
      },
      async showWarningMessage() {
        return undefined
      },
      async showInformationMessage() {
        return undefined
      },
      async showErrorMessage() {
        return undefined
      },
      async showQuickPick() {
        return undefined
      },
      async showInputBox() {
        return undefined
      },
      async showOpenDialog() {
        return undefined
      },
      async showSaveDialog() {
        return undefined
      },
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration(section) {
        return {
          get(key, defaultValue) {
            if (section === 'codexSwitch' && key === 'storageMode') {
              return 'secretStorage'
            }
            if (section === 'codexSwitch' && key === 'activeProfileScope') {
              return 'global'
            }
            if (section === 'codexSwitch' && key === 'runtimeIsolationMode') {
              return 'sharedRuntime'
            }
            if (section === 'codexSwitch' && key === 'quotaRefreshInterval') {
              return 0
            }
            if (section === 'codexSwitch' && key === 'autoRenewTokens') {
              return false
            }
            if (
              section === 'codexSwitch' &&
              key === 'reloadWindowAfterProfileSwitch'
            ) {
              return false
            }
            if (section === 'codexSwitch' && key === 'statusBarClickBehavior') {
              return 'cycle'
            }
            if (section === 'codexSwitch' && key === 'statusBarSwitchTrigger') {
              return 'click'
            }
            if (
              section === 'chatgpt' &&
              key === 'runCodexInWindowsSubsystemForLinux'
            ) {
              return false
            }
            return defaultValue
          },
          has() {
            return false
          },
        }
      },
      createFileSystemWatcher() {
        return {
          onDidCreate() {},
          onDidChange() {},
          onDidDelete() {},
          dispose() {},
        }
      },
      onDidChangeConfiguration() {
        return { dispose() {} }
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
        const callback = registeredCommands.get(command)
        if (!callback) {
          return undefined
        }
        return callback(...args)
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

test('extension activation does not overwrite a newer external auth.json session', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-extension-activate-'),
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
      const extension = require('../out/extension.js')
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
      fs.mkdirSync(codexHome, { recursive: true })
      fs.writeFileSync(
        path.join(codexHome, 'auth.json'),
        buildCodexAuthJson(externalAuth),
        'utf8',
      )

      extension.activate(context)
      await new Promise((resolve) => setImmediate(resolve))

      const authJson = JSON.parse(
        fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'),
      )
      assert.equal(authJson.tokens.refresh_token, 'external-refresh')
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})
