const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

function createFileUri(fsPath) {
  return {
    scheme: 'file',
    fsPath,
    path: fsPath,
    authority: '',
    toString() {
      return `file://${fsPath}`
    },
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
      appRoot: options.appRoot ?? '',
      uriScheme: options.uriScheme ?? 'vscode',
    },
    workspace: {
      workspaceFile: options.workspaceFile,
      workspaceFolders: options.workspaceFolders,
      getConfiguration(section) {
        return {
          get(key, defaultValue) {
            if (section === 'codexSwitch' && key === 'runtimeIsolationMode') {
              return options.runtimeIsolationMode ?? 'sharedRuntime'
            }
            if (section === 'codexSwitch' && key === 'activeProfileScope') {
              return options.activeProfileScope ?? 'global'
            }
            if (section === 'codexUsage' && key === 'activeProfileScope') {
              return options.legacyActiveProfileScope ?? 'global'
            }
            return defaultValue
          },
          has() {
            return false
          },
        }
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

test('shared runtime ignores workspace-scoped active profile state', async () => {
  const vscodeMock = createVscodeMock({
    runtimeIsolationMode: 'sharedRuntime',
    activeProfileScope: 'workspace',
    workspaceFolders: [{ name: 'repo', uri: createFileUri('/tmp/repo') }],
  })

  await withMockedVscode(vscodeMock, async () => {
    const isolation = require('../out/auth/runtime-isolation.js')
    assert.equal(isolation.getEffectiveActiveProfileScope(), 'global')

    const status = isolation.getRuntimeIsolationStatus()
    assert.equal(status.mode, 'sharedRuntime')
    assert.equal(status.requiresRelaunch, false)
    assert.match(status.warningMessage, /ignored/)
  })
})

test('isolated instance descriptor and launch command are derived from the workspace', async () => {
  const workspaceFile = createFileUri('/tmp/project/project.code-workspace')
  const vscodeMock = createVscodeMock({
    runtimeIsolationMode: 'isolatedInstance',
    workspaceFile,
    workspaceFolders: [{ name: 'project', uri: createFileUri('/tmp/project') }],
  })

  await withMockedVscode(vscodeMock, async () => {
    const isolation = require('../out/auth/runtime-isolation.js')
    const descriptor = isolation.getWorkspaceIsolationDescriptor()
    const launch = isolation.buildIsolatedLaunchCommand(descriptor)

    assert.ok(descriptor.baseDir.includes('.codex-switch'))
    assert.ok(descriptor.baseDir.includes('isolated-workspaces'))
    assert.equal(descriptor.launchTarget.kind, 'localPaths')
    assert.deepEqual(descriptor.launchTarget.paths, [
      '/tmp/project/project.code-workspace',
    ])

    assert.ok(launch)
    assert.deepEqual(launch.args.slice(0, 4), [
      '--new-window',
      '--user-data-dir',
      descriptor.userDataDir,
      '--skip-add-to-recently-opened',
    ])
    assert.deepEqual(launch.args.slice(4), [
      '/tmp/project/project.code-workspace',
    ])
    assert.equal(launch.env.CODEX_HOME, descriptor.codexHome)
    assert.equal(
      launch.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY,
      descriptor.workspaceKey,
    )
  })
})

test('isolated instance status requires the managed env markers', async () => {
  const workspaceFile = createFileUri('/tmp/project/project.code-workspace')
  const vscodeMock = createVscodeMock({
    runtimeIsolationMode: 'isolatedInstance',
    workspaceFile,
  })

  await withMockedVscode(vscodeMock, async () => {
    const isolation = require('../out/auth/runtime-isolation.js')
    const descriptor = isolation.getWorkspaceIsolationDescriptor()
    const previousCodexHome = process.env.CODEX_HOME
    const previousKey = process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY
    const previousUserData = process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR

    process.env.CODEX_HOME = descriptor.codexHome
    process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY = descriptor.workspaceKey
    process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR = descriptor.userDataDir

    try {
      const status = isolation.getRuntimeIsolationStatus()
      assert.equal(status.isManagedWindow, true)
      assert.equal(status.requiresRelaunch, false)
      assert.equal(status.warningMessage, undefined)
    } finally {
      if (typeof previousCodexHome === 'undefined') {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      if (typeof previousKey === 'undefined') {
        delete process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY
      } else {
        process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY = previousKey
      }
      if (typeof previousUserData === 'undefined') {
        delete process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR
      } else {
        process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR = previousUserData
      }
    }
  })
})

test('managed user-data directory repairs missing isolated runtime env markers', async () => {
  const workspaceFile = createFileUri('/tmp/project/project.code-workspace')
  const vscodeMock = createVscodeMock({
    runtimeIsolationMode: 'isolatedInstance',
    workspaceFile,
  })

  await withMockedVscode(vscodeMock, async () => {
    const isolation = require('../out/auth/runtime-isolation.js')
    const descriptor = isolation.getWorkspaceIsolationDescriptor()
    const previousCodexHome = process.env.CODEX_HOME
    const previousKey = process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY
    const previousUserData = process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR

    delete process.env.CODEX_HOME
    delete process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY
    delete process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR

    try {
      const repaired = isolation.adoptManagedRuntimeEnvironmentFromContext({
        globalStorageUri: createFileUri(
          path.join(
            descriptor.userDataDir,
            'User',
            'globalStorage',
            'woozy-masta.codex-switch',
          ),
        ),
      })

      assert.equal(repaired, true)
      assert.equal(process.env.CODEX_HOME, descriptor.codexHome)
      assert.equal(
        process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY,
        descriptor.workspaceKey,
      )
      assert.equal(
        process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR,
        descriptor.userDataDir,
      )

      const status = isolation.getRuntimeIsolationStatus()
      assert.equal(status.isManagedWindow, true)
      assert.equal(status.requiresRelaunch, false)
      assert.equal(status.warningMessage, undefined)
    } finally {
      if (typeof previousCodexHome === 'undefined') {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      if (typeof previousKey === 'undefined') {
        delete process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY
      } else {
        process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY = previousKey
      }
      if (typeof previousUserData === 'undefined') {
        delete process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR
      } else {
        process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR = previousUserData
      }
    }
  })
})

test('unmanaged user-data directory does not repair isolated runtime env markers', async () => {
  const workspaceFile = createFileUri('/tmp/project/project.code-workspace')
  const vscodeMock = createVscodeMock({
    runtimeIsolationMode: 'isolatedInstance',
    workspaceFile,
  })

  await withMockedVscode(vscodeMock, async () => {
    const isolation = require('../out/auth/runtime-isolation.js')
    const descriptor = isolation.getWorkspaceIsolationDescriptor()
    const previousCodexHome = process.env.CODEX_HOME
    const previousKey = process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY
    const previousUserData = process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR

    delete process.env.CODEX_HOME
    delete process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY
    delete process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR

    try {
      const repaired = isolation.adoptManagedRuntimeEnvironmentFromContext({
        globalStorageUri: createFileUri(
          path.join(
            descriptor.baseDir,
            'other-user-data',
            'User',
            'globalStorage',
            'woozy-masta.codex-switch',
          ),
        ),
      })

      assert.equal(repaired, false)
      assert.equal(process.env.CODEX_HOME, undefined)
      assert.equal(process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY, undefined)
      assert.equal(process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR, undefined)
    } finally {
      if (typeof previousCodexHome === 'undefined') {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      if (typeof previousKey === 'undefined') {
        delete process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY
      } else {
        process.env.CODEX_SWITCH_ISOLATED_WORKSPACE_KEY = previousKey
      }
      if (typeof previousUserData === 'undefined') {
        delete process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR
      } else {
        process.env.CODEX_SWITCH_ISOLATED_USER_DATA_DIR = previousUserData
      }
    }
  })
})
