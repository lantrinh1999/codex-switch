const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildAuthPayload,
  fetchQuotaInfo,
  formatQuotaSummary,
  getTokenStatus,
  pickBestQuotaProfileId,
} = require('../out/health/profile-health.js')

function makeJwt(payload) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' }),
  ).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.`
}

function makeAuthData(now) {
  return {
    idToken: makeJwt({
      email: 'person@example.com',
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'plus',
      },
    }),
    accessToken: makeJwt({
      exp: Math.floor((now + 2 * 60 * 60 * 1000) / 1000),
    }),
    refreshToken: 'refresh-token',
    email: 'person@example.com',
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

test('getTokenStatus formats expiry relative to now', () => {
  const now = Date.UTC(2026, 3, 12, 0, 0, 0)
  const authData = makeAuthData(now)
  const tokenStatus = getTokenStatus(authData, now)

  assert.equal(tokenStatus.isExpired, false)
  assert.equal(tokenStatus.label, 'expires in 2h0m')
})

test('fetchQuotaInfo refreshes the access token after a 401 and retries', async () => {
  const now = Date.UTC(2026, 3, 12, 0, 0, 0)
  const refreshedAccessToken = makeJwt({
    exp: Math.floor((now + 6 * 60 * 60 * 1000) / 1000),
  })
  const payload = buildAuthPayload(makeAuthData(now))
  const calls = []

  const transport = {
    async get(_url, headers) {
      calls.push({ method: 'GET', auth: headers.Authorization })
      if (calls.length === 1) {
        throw {
          statusCode: 401,
          body: JSON.stringify({ detail: 'authentication token missing' }),
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: {
              used_percent: 0,
              reset_at: Math.floor((now + 4 * 60 * 60 * 1000) / 1000),
              limit_window_seconds: 18000,
            },
            secondary_window: {
              used_percent: 46,
              reset_at: Math.floor((now + 5 * 24 * 60 * 60 * 1000) / 1000),
              limit_window_seconds: 604800,
            },
          },
        }),
      }
    },
    async post(_url, body) {
      calls.push({ method: 'POST', body })
      return {
        statusCode: 200,
        body: JSON.stringify({
          access_token: refreshedAccessToken,
          refresh_token: 'refresh-token-2',
          id_token: payload.tokens.id_token,
        }),
      }
    },
  }

  const result = await fetchQuotaInfo(payload, transport)

  assert.equal(result.payload.tokens.access_token, refreshedAccessToken)
  assert.equal(result.payload.tokens.refresh_token, 'refresh-token-2')
  assert.equal(result.quotaInfo.unavailableReason, null)
  assert.equal(result.quotaInfo.primaryWindow.remainingPercent, 100)
  assert.equal(result.quotaInfo.secondaryWindow.remainingPercent, 54)
  assert.equal(formatQuotaSummary(result.quotaInfo), '5h 100% · 7d 54%')
  assert.deepEqual(
    calls.map((entry) => entry.method),
    ['GET', 'POST', 'GET'],
  )
})

test('pickBestQuotaProfileId chooses the highest remaining quota', () => {
  const profiles = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ]
  const states = new Map([
    [
      'a',
      {
        quotaInfo: {
          primaryWindow: { remainingPercent: 40 },
          secondaryWindow: { remainingPercent: 90 },
        },
      },
    ],
    [
      'b',
      {
        quotaInfo: {
          primaryWindow: { remainingPercent: 70 },
          secondaryWindow: { remainingPercent: 10 },
        },
      },
    ],
    [
      'c',
      {
        quotaInfo: {
          primaryWindow: { remainingPercent: 70 },
          secondaryWindow: { remainingPercent: 80 },
        },
      },
    ],
  ])

  assert.equal(pickBestQuotaProfileId(profiles, states), 'c')
  assert.equal(pickBestQuotaProfileId(profiles, states, 'c'), 'c')
})
