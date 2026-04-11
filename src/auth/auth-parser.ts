import { AuthData } from '../types'

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const v = value.trim()
  return v ? v : undefined
}

function getDefaultOrganization(authPayload: Record<string, unknown>): {
  id?: string
  title?: string
} {
  const directId =
    asNonEmptyString(authPayload.selected_organization_id) ||
    asNonEmptyString(authPayload.default_organization_id)

  const organizations = Array.isArray(authPayload.organizations)
    ? authPayload.organizations
    : []

  if (directId) {
    const match = organizations.find((org) => {
      if (!org || typeof org !== 'object' || Array.isArray(org)) {
        return false
      }
      return asNonEmptyString((org as Record<string, unknown>).id) === directId
    }) as Record<string, unknown> | undefined

    return {
      id: directId,
      title: asNonEmptyString(match?.title),
    }
  }

  if (organizations.length === 0) {
    return {}
  }

  const selected =
    organizations.find((org) => {
      if (!org || typeof org !== 'object' || Array.isArray(org)) {
        return false
      }
      return Boolean((org as Record<string, unknown>).is_default)
    }) || organizations[0]

  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    return {}
  }

  return {
    id: asNonEmptyString((selected as Record<string, unknown>).id),
    title: asNonEmptyString((selected as Record<string, unknown>).title),
  }
}

export function parseJWT(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      throw new Error('Invalid JWT')
    }
    const payload = Buffer.from(parts[1], 'base64url').toString()
    const parsed = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

export function loadAuthDataFromJson(authJson: unknown): AuthData | null {
  if (!authJson || typeof authJson !== 'object' || Array.isArray(authJson)) {
    return null
  }

  const payload = authJson as Record<string, unknown>
  const tokens =
    payload.tokens &&
    typeof payload.tokens === 'object' &&
    !Array.isArray(payload.tokens)
      ? (payload.tokens as Record<string, unknown>)
      : null

  if (!tokens) {
    return null
  }

  const idToken = asNonEmptyString(tokens.id_token)
  const accessToken = asNonEmptyString(tokens.access_token)
  const refreshToken = asNonEmptyString(tokens.refresh_token)
  if (!idToken || !accessToken || !refreshToken) {
    return null
  }

  const idTokenPayload = parseJWT(idToken)
  const authPayloadRaw = idTokenPayload['https://api.openai.com/auth']
  const authPayload =
    authPayloadRaw &&
    typeof authPayloadRaw === 'object' &&
    !Array.isArray(authPayloadRaw)
      ? (authPayloadRaw as Record<string, unknown>)
      : {}
  const defaultOrganization = getDefaultOrganization(authPayload)

  return {
    idToken,
    accessToken,
    refreshToken,
    accountId: asNonEmptyString(tokens.account_id),
    defaultOrganizationId: defaultOrganization.id,
    defaultOrganizationTitle: defaultOrganization.title,
    chatgptUserId: asNonEmptyString(authPayload.chatgpt_user_id),
    userId: asNonEmptyString(authPayload.user_id),
    subject: asNonEmptyString(idTokenPayload.sub),
    email: asNonEmptyString(idTokenPayload.email) || 'Unknown',
    planType: asNonEmptyString(authPayload.chatgpt_plan_type) || 'Unknown',
    authJson: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
  }
}
