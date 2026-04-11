const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

function createVscodeMock() {
  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label
      this.collapsibleState = collapsibleState
    }
  }

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

  return {
    l10n: {
      t(message, ...args) {
        return message.replace(/\{(\d+)\}/g, (_, index) =>
          String(args[Number(index)] ?? ''),
        )
      },
    },
    TreeItem,
    EventEmitter,
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

test('profile tree roots start collapsed and preserve expansion state', async () => {
  const vscodeMock = createVscodeMock()

  await withMockedVscode(vscodeMock, async () => {
    const { ProfileTreeProvider } = require('../out/ui/profile-tree.js')
    const provider = new ProfileTreeProvider()
    const profiles = [
      {
        id: 'profile-1',
        name: 'Work',
        email: 'work@example.com',
        planType: 'plus',
        createdAt: '2026-04-12T00:00:00.000Z',
        updatedAt: '2026-04-12T00:00:00.000Z',
      },
    ]

    provider.setState(profiles, undefined, new Map())
    assert.equal(
      provider.getRootItems()[0].collapsibleState,
      vscodeMock.TreeItemCollapsibleState.Collapsed,
    )

    provider.setExpanded('profile-1', true)
    provider.setState(profiles, undefined, new Map())
    assert.equal(
      provider.getRootItems()[0].collapsibleState,
      vscodeMock.TreeItemCollapsibleState.Expanded,
    )

    provider.setExpanded('profile-1', false)
    provider.setState(profiles, undefined, new Map())
    assert.equal(
      provider.getRootItems()[0].collapsibleState,
      vscodeMock.TreeItemCollapsibleState.Collapsed,
    )
  })
})
