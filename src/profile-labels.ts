import { ProfileSummary, RuntimeSession } from './types'

const UNKNOWN_LABEL = 'Unknown'

function normalizeNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim()
  return normalized ? normalized : undefined
}

function normalizeComparable(value: string | undefined): string | undefined {
  return normalizeNonEmpty(value)?.toLocaleLowerCase()
}

function areEquivalent(
  value: string | undefined,
  candidates: Array<string | undefined>,
): boolean {
  const normalized = normalizeComparable(value)
  if (!normalized) {
    return false
  }

  return candidates.some(
    (candidate) => normalized === normalizeComparable(candidate),
  )
}

export function getKnownEmail(email: string | undefined): string | undefined {
  const normalized = normalizeNonEmpty(email)
  if (!normalized) {
    return undefined
  }

  return normalized.toLocaleLowerCase() === UNKNOWN_LABEL.toLocaleLowerCase()
    ? undefined
    : normalized
}

export function getAccountPrimaryLabel(
  email: string | undefined,
): string | undefined {
  const knownEmail = getKnownEmail(email)
  if (!knownEmail) {
    return undefined
  }

  const localPart = normalizeNonEmpty(knownEmail.split('@')[0])
  return localPart || knownEmail
}

function getAlias(
  name: string | undefined,
  email: string | undefined,
  primaryLabel: string | undefined,
): string | undefined {
  const normalizedName = normalizeNonEmpty(name)
  if (!normalizedName) {
    return undefined
  }

  const knownEmail = getKnownEmail(email)
  const emailLabel = getAccountPrimaryLabel(email)
  if (areEquivalent(normalizedName, [primaryLabel, knownEmail, emailLabel])) {
    return undefined
  }

  return normalizedName
}

export function getProfilePrimaryLabel(
  profile: Pick<ProfileSummary, 'name' | 'email'>,
): string {
  return (
    getAccountPrimaryLabel(profile.email) ||
    normalizeNonEmpty(profile.name) ||
    UNKNOWN_LABEL
  )
}

export function getProfileAlias(
  profile: Pick<ProfileSummary, 'name' | 'email'>,
): string | undefined {
  return getAlias(profile.name, profile.email, getProfilePrimaryLabel(profile))
}

export function getProfileFullEmail(
  profile: Pick<ProfileSummary, 'email'>,
): string | undefined {
  return getKnownEmail(profile.email)
}

export function getRuntimePrimaryLabel(
  runtimeSession: Pick<RuntimeSession, 'authData'>,
  fallbackProfile?: Pick<ProfileSummary, 'name' | 'email'>,
): string {
  return (
    getAccountPrimaryLabel(runtimeSession.authData?.email) ||
    (fallbackProfile ? getProfilePrimaryLabel(fallbackProfile) : UNKNOWN_LABEL)
  )
}

export function getRuntimeAlias(
  runtimeSession: Pick<RuntimeSession, 'authData'>,
  profile: Pick<ProfileSummary, 'name' | 'email'>,
): string | undefined {
  return getAlias(
    profile.name,
    getKnownEmail(runtimeSession.authData?.email) || profile.email,
    getRuntimePrimaryLabel(runtimeSession, profile),
  )
}

export function getRuntimeFullEmail(
  runtimeSession: Pick<RuntimeSession, 'authData'>,
): string | undefined {
  return getKnownEmail(runtimeSession.authData?.email)
}
