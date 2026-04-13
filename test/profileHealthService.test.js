const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const https = require('node:https')
const Module = require('node:module')
const { EventEmitter } = require('node:events')

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

function createVscodeMock(options = {}) {
  const configurationValues = {
    activeProfileScope: 'global',
    storageMode: options.storageMode ?? 'secretStorage',
    quotaRefreshInterval:
      typeof options.quotaRefreshInterval === 'number'
        ? options.quotaRefreshInterval
        : 300,
    autoRenewTokens:
      typeof options.autoRenewTokens === 'boolean'
        ? options.autoRenewTokens
        : true,
    tokenAutoRenewIntervalMinutes:
      options.tokenAutoRenewIntervalMinutes ?? 60,
  }

  const listeners = new Set()

  return {
    __setConfiguration(key, value) {
      configurationValues[key] = value
    },
    __fireConfigurationChange(...keys) {
      for (const listener of listeners) {
        listener({
          affectsConfiguration(name) {
            return keys.includes(name)
          },
        })
      }
    },
    l10n: {
      t(message, ...args) {
        return message.replace(/\{(\d+)\}/g, (_, index) =>
          String(args[Number(index)] ?? ''),
        )
      },
    },
    env: {
      remoteName: options.remoteName,
    },
    workspace: {
      getConfiguration(section) {
        return {
          get(key, defaultValue) {
            if (section === 'codexSwitch' && key in configurationValues) {
              return configurationValues[key]
            }
            return defaultValue
          },
          has() {
            return false
          },
        }
      },
      onDidChangeConfiguration(listener) {
        listeners.add(listener)
        return {
          dispose() {
            listeners.delete(listener)
          },
        }
      },
    },
    EventEmitter: class VscodeEventEmitter {
      constructor() {
        this.emitter = new EventEmitter()
        this.event = (listener) => {
          this.emitter.on('event', listener)
          return {
            dispose: () => this.emitter.off('event', listener),
          }
        }
      }

      fire(value) {
        this.emitter.emit('event', value)
      }

      dispose() {
        this.emitter.removeAllListeners()
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

async function withMockedHttps(handler, fn) {
  const originalRequest = https.request

  https.request = (options, callback) => {
    const requestEmitter = new EventEmitter()
    let body = ''

    const req = {
      on(event, listener) {
        requestEmitter.on(event, listener)
        return req
      },
      setTimeout() {},
      write(chunk) {
        body += String(chunk)
      },
      end() {
        process.nextTick(() => {
          const responseEmitter = new EventEmitter()
          const response = {
            statusCode: 200,
            on(event, listener) {
              responseEmitter.on(event, listener)
              return response
            },
          }

          try {
            const result = handler(options, body)
            response.statusCode = result.statusCode
            callback(response)
            if (result.body) {
              responseEmitter.emit('data', result.body)
            }
            responseEmitter.emit('end')
          } catch (error) {
            requestEmitter.emit('error', error)
          }
        })
      },
      destroy(error) {
        if (error) {
          requestEmitter.emit('error', error)
        }
      },
    }

    return req
  }

  try {
    return await fn()
  } finally {
    https.request = originalRequest
  }
}

function createAuthData(email, refreshToken, options = {}) {
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
      ...(options.lastRefresh ? { last_refresh: options.lastRefresh } : {}),
    },
  }
}

test('manual token renewal persists rotated tokens and updates the active auth.json', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-health-service-manual-'),
  )
  const codexHome = path.join(tempDir, 'codex-home')
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  const vscodeMock = createVscodeMock({
    quotaRefreshInterval: 0,
    autoRenewTokens: false,
  })

  try {
    await withMockedVscode(vscodeMock, async () => {
      const { ProfileManager } = require('../out/auth/profile-manager.js')
      const {
        ProfileHealthService,
      } = require('../out/health/profile-health-service.js')

      const context = createExtensionContext(globalStoragePath)
      const profileManager = new ProfileManager(context)
      const healthService = new ProfileHealthService(profileManager)
      const profile = await profileManager.createProfile(
        'manual-renew',
        createAuthData('manual@example.com', 'refresh-original'),
      )
      await profileManager.setActiveProfileId(profile.id)

      await withMockedHttps(
        (_options, body) => {
          assert.match(body, /grant_type=refresh_token/)
          assert.match(body, /refresh_token=refresh-original/)
          return {
            statusCode: 200,
            body: JSON.stringify({
              access_token: 'access-rotated',
              refresh_token: 'refresh-rotated',
              id_token: makeJwt({
                email: 'manual@example.com',
                sub: 'manual@example.com',
                'https://api.openai.com/auth': {
                  chatgpt_plan_type: 'plus',
                },
              }),
            }),
          }
        },
        async () => {
          const renewed = await healthService.refreshToken(profile.id)
          assert.equal(renewed, true)
        },
      )

      const storedAuth = await profileManager.loadAuthData(profile.id)
      assert.equal(storedAuth.accessToken, 'access-rotated')
      assert.equal(storedAuth.refreshToken, 'refresh-rotated')
      assert.ok(typeof storedAuth.authJson.last_refresh === 'string')

      const authPath = path.join(codexHome, 'auth.json')
      const activeAuth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      assert.equal(activeAuth.tokens.access_token, 'access-rotated')
      assert.equal(activeAuth.tokens.refresh_token, 'refresh-rotated')
      assert.ok(typeof activeAuth.last_refresh === 'string')

      healthService.dispose()
    })
  } finally {
    if (typeof previousCodexHome === 'undefined') {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }
  }
})

test('automatic token renewal only renews due profiles and does not call quota APIs', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-health-service-auto-'),
  )
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const vscodeMock = createVscodeMock({
    quotaRefreshInterval: 0,
    autoRenewTokens: true,
    tokenAutoRenewIntervalMinutes: 60,
  })

  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  global.setTimeout = () => ({})
  global.clearTimeout = () => {}

  try {
    await withMockedVscode(vscodeMock, async () => {
      const { ProfileManager } = require('../out/auth/profile-manager.js')
      const {
        ProfileHealthService,
      } = require('../out/health/profile-health-service.js')

      const context = createExtensionContext(globalStoragePath)
      const profileManager = new ProfileManager(context)
      const healthService = new ProfileHealthService(profileManager)

      const staleProfile = await profileManager.createProfile(
        'stale',
        createAuthData('stale@example.com', 'refresh-stale', {
          lastRefresh: '2026-04-11T20:00:00.000Z',
        }),
      )
      const freshProfile = await profileManager.createProfile(
        'fresh',
        createAuthData('fresh@example.com', 'refresh-fresh', {
          lastRefresh: new Date().toISOString(),
        }),
      )
      await profileManager.createProfile(
        'missing',
        createAuthData('missing@example.com', ''),
      )

      const requests = []
      await withMockedHttps(
        (options, body) => {
          requests.push({ options, body })
          if (options.path !== '/oauth/token') {
            throw new Error(`Unexpected request path: ${options.path}`)
          }

          return {
            statusCode: 200,
            body: JSON.stringify({
              access_token: 'access-auto-rotated',
              refresh_token: 'refresh-auto-rotated',
              id_token: makeJwt({
                email: 'stale@example.com',
                sub: 'stale@example.com',
                'https://api.openai.com/auth': {
                  chatgpt_plan_type: 'plus',
                },
              }),
            }),
          }
        },
        async () => {
          await healthService.refreshDueTokens()
        },
      )

      assert.equal(requests.length, 1)
      assert.match(requests[0].body, /refresh_token=refresh-stale/)

      const staleAuth = await profileManager.loadAuthData(staleProfile.id)
      const freshAuth = await profileManager.loadAuthData(freshProfile.id)
      assert.equal(staleAuth.refreshToken, 'refresh-auto-rotated')
      assert.equal(freshAuth.refreshToken, 'refresh-fresh')

      const staleState = healthService.getState(staleProfile.id)
      assert.ok(typeof staleState?.lastRenewedAt === 'string')

      healthService.dispose()
    })
  } finally {
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
  }
})

test('token auto-renew timer restarts when configuration changes', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-health-service-timers-'),
  )
  const globalStoragePath = path.join(tempDir, 'storage')
  fs.mkdirSync(globalStoragePath, { recursive: true })

  const vscodeMock = createVscodeMock({
    quotaRefreshInterval: 300,
    autoRenewTokens: true,
    tokenAutoRenewIntervalMinutes: 60,
  })

  const originalSetInterval = global.setInterval
  const originalClearInterval = global.clearInterval
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  const intervalCalls = []
  const clearedIntervals = []

  global.setInterval = (callback, delay) => {
    const handle = { callback, delay }
    intervalCalls.push(delay)
    return handle
  }
  global.clearInterval = (handle) => {
    clearedIntervals.push(handle?.delay ?? null)
  }
  global.setTimeout = (_callback, delay) => ({ delay })
  global.clearTimeout = () => {}

  try {
    await withMockedVscode(vscodeMock, async () => {
      const { ProfileManager } = require('../out/auth/profile-manager.js')
      const {
        ProfileHealthService,
      } = require('../out/health/profile-health-service.js')

      const context = createExtensionContext(globalStoragePath)
      const profileManager = new ProfileManager(context)
      const healthService = new ProfileHealthService(profileManager)

      assert.deepEqual(intervalCalls.slice(0, 2), [300000, 3600000])

      vscodeMock.__setConfiguration('tokenAutoRenewIntervalMinutes', 90)
      vscodeMock.__fireConfigurationChange(
        'codexSwitch.tokenAutoRenewIntervalMinutes',
      )

      assert.deepEqual(intervalCalls.slice(2), [5400000])
      assert.ok(clearedIntervals.includes(3600000))

      healthService.dispose()
    })
  } finally {
    global.setInterval = originalSetInterval
    global.clearInterval = originalClearInterval
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
  }
})
