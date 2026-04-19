import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export const SHARED_STORE_DIRNAME = '.codex-switch'
export const SHARED_PROFILES_DIRNAME = 'profiles'
export const SHARED_LOCKS_DIRNAME = 'locks'
export const SHARED_PROFILES_FILENAME = 'profiles.json'
export const SHARED_ACTIVE_PROFILE_FILENAME = 'active-profile.json'
const LEASE_FILE_MODE = 0o600

interface SharedLeaseFile {
  owner: string
  acquiredAt: string
  expiresAt: string
}

export interface SharedActiveProfile {
  profileId: string
  updatedAt: string
}

export function getSharedStoreRoot(): string {
  return path.join(os.homedir(), SHARED_STORE_DIRNAME)
}

export function getSharedProfilesDir(): string {
  return path.join(getSharedStoreRoot(), SHARED_PROFILES_DIRNAME)
}

export function getSharedLocksDir(): string {
  return path.join(getSharedStoreRoot(), SHARED_LOCKS_DIRNAME)
}

export function getSharedProfilesPath(): string {
  return path.join(getSharedStoreRoot(), SHARED_PROFILES_FILENAME)
}

export function getSharedActiveProfilePath(): string {
  return path.join(getSharedStoreRoot(), SHARED_ACTIVE_PROFILE_FILENAME)
}

export function getSharedProfileSecretsPath(profileId: string): string {
  return path.join(getSharedProfilesDir(), `${profileId}.json`)
}

export function getSharedProfileRenewLeasePath(profileId: string): string {
  return path.join(getSharedLocksDir(), `${profileId}.renew.lock`)
}

export function ensureSharedStoreDirs(): void {
  fs.mkdirSync(getSharedStoreRoot(), { recursive: true, mode: 0o700 })
  fs.mkdirSync(getSharedProfilesDir(), { recursive: true, mode: 0o700 })
  fs.mkdirSync(getSharedLocksDir(), { recursive: true, mode: 0o700 })
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

export function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`,
  )
  const content = JSON.stringify(data, null, 2)

  fs.writeFileSync(tmpPath, content, {
    encoding: 'utf8',
    mode: LEASE_FILE_MODE,
  })

  try {
    try {
      fs.renameSync(tmpPath, filePath)
      return
    } catch {
      fs.copyFileSync(tmpPath, filePath)
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath)
      }
    } catch {
      // ignore cleanup failures
    }
  }
}

export function deleteFileIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // ignore cleanup failures
  }
}

function isLeaseExpired(
  lease: SharedLeaseFile | null,
  now = Date.now(),
): boolean {
  if (
    !lease ||
    typeof lease.expiresAt !== 'string' ||
    !lease.expiresAt.trim()
  ) {
    return true
  }

  const expiresAt = Date.parse(lease.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

function tryWriteLeaseFile(
  filePath: string,
  owner: string,
  ttlMs: number,
  now: number,
): boolean {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const lease: SharedLeaseFile = {
    owner,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  }

  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'wx', LEASE_FILE_MODE)
    fs.writeFileSync(fd, JSON.stringify(lease, null, 2), {
      encoding: 'utf8',
      mode: LEASE_FILE_MODE,
    })
    return true
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: string }).code)
        : undefined
    if (code === 'EEXIST') {
      return false
    }
    throw error
  } finally {
    if (typeof fd === 'number') {
      fs.closeSync(fd)
    }
  }
}

export function acquireJsonLease(
  filePath: string,
  owner: string,
  ttlMs: number,
  now = Date.now(),
): boolean {
  if (tryWriteLeaseFile(filePath, owner, ttlMs, now)) {
    return true
  }

  const existing = readJsonFile<SharedLeaseFile>(filePath)
  if (!isLeaseExpired(existing, now)) {
    return false
  }

  deleteFileIfExists(filePath)
  return tryWriteLeaseFile(filePath, owner, ttlMs, now)
}

export function releaseJsonLease(filePath: string, owner: string): void {
  const existing = readJsonFile<SharedLeaseFile>(filePath)
  if (existing && existing.owner && existing.owner !== owner) {
    return
  }
  deleteFileIfExists(filePath)
}
