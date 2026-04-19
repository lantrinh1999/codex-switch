const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function withTemporaryHome(fn) {
  const tempHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-shared-store-'),
  )
  const previousHome = process.env.HOME
  process.env.HOME = tempHome

  try {
    return fn(tempHome)
  } finally {
    if (typeof previousHome === 'undefined') {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
  }
}

test('shared profile renew leases block concurrent owners until released', () => {
  withTemporaryHome(() => {
    const sharedStore = require('../out/auth/shared-profile-store.js')
    sharedStore.ensureSharedStoreDirs()

    const leasePath = sharedStore.getSharedProfileRenewLeasePath('profile-1')
    assert.equal(
      sharedStore.acquireJsonLease(leasePath, 'owner-a', 60000),
      true,
    )
    assert.equal(
      sharedStore.acquireJsonLease(leasePath, 'owner-b', 60000),
      false,
    )

    sharedStore.releaseJsonLease(leasePath, 'owner-a')
    assert.equal(
      sharedStore.acquireJsonLease(leasePath, 'owner-b', 60000),
      true,
    )
  })
})

test('expired shared renew leases can be reclaimed', () => {
  withTemporaryHome(() => {
    const sharedStore = require('../out/auth/shared-profile-store.js')
    sharedStore.ensureSharedStoreDirs()

    const leasePath = sharedStore.getSharedProfileRenewLeasePath('profile-2')
    fs.writeFileSync(
      leasePath,
      JSON.stringify({
        owner: 'expired-owner',
        acquiredAt: '2026-04-10T00:00:00.000Z',
        expiresAt: '2026-04-10T00:05:00.000Z',
      }),
      'utf8',
    )

    assert.equal(
      sharedStore.acquireJsonLease(
        leasePath,
        'new-owner',
        60000,
        Date.parse('2026-04-12T00:00:00.000Z'),
      ),
      true,
    )
  })
})

test('shared JSON writes stay valid after overwriting persisted token data', () => {
  withTemporaryHome(() => {
    const sharedStore = require('../out/auth/shared-profile-store.js')
    sharedStore.ensureSharedStoreDirs()

    const secretsPath = sharedStore.getSharedProfileSecretsPath('profile-3')
    sharedStore.writeJsonFile(secretsPath, {
      tokens: {
        access_token: 'access-old',
        refresh_token: 'refresh-old',
      },
    })
    sharedStore.writeJsonFile(secretsPath, {
      tokens: {
        access_token: 'access-new',
        refresh_token: 'refresh-new',
      },
      last_refresh: '2026-04-12T05:00:00.000Z',
    })

    const stored = JSON.parse(fs.readFileSync(secretsPath, 'utf8'))
    assert.deepEqual(stored, {
      tokens: {
        access_token: 'access-new',
        refresh_token: 'refresh-new',
      },
      last_refresh: '2026-04-12T05:00:00.000Z',
    })
  })
})
