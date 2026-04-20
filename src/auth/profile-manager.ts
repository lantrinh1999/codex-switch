import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { AuthData, ProfileSummary, RuntimeSession, StorageMode } from '../types'
import { getDefaultCodexAuthPath, loadAuthDataFromFile } from './auth-manager'
import { syncCodexAuthFile } from './codex-auth-sync'
import { getProfilePrimaryLabel } from '../profile-labels'
import {
  acquireJsonLease,
  SharedActiveProfile,
  SHARED_ACTIVE_PROFILE_FILENAME,
  deleteFileIfExists,
  ensureSharedStoreDirs,
  getSharedActiveProfilePath,
  getSharedProfileRenewLeasePath,
  getSharedProfileSecretsPath,
  getSharedProfilesDir,
  getSharedProfilesPath,
  getSharedStoreRoot,
  readJsonFile,
  releaseJsonLease,
  writeJsonFile,
} from './shared-profile-store'

type ProfileTokens = Pick<
  AuthData,
  'idToken' | 'accessToken' | 'refreshToken' | 'accountId' | 'authJson'
>

interface ProfilesFileV1 {
  version: 1
  profiles: ProfileSummary[]
}

const PROFILES_FILENAME = 'profiles.json'
const ACTIVE_PROFILE_KEY = 'codexSwitch.activeProfileId'
const LAST_PROFILE_KEY = 'codexSwitch.lastProfileId'
const MIGRATED_LEGACY_KEY = 'codexSwitch.migratedLegacyProfiles'
const PROFILE_RENEW_LEASE_TTL_MS = 5 * 60 * 1000

// Backward compatibility keys (pre-rename).
const OLD_ACTIVE_PROFILE_KEY = 'codexUsage.activeProfileId'
const OLD_LAST_PROFILE_KEY = 'codexUsage.lastProfileId'
const OLD_SECRET_PREFIX = 'codexUsage.profile.'
const NEW_SECRET_PREFIX = 'codexSwitch.profile.'

interface ExportedProfileEntryV1 {
  profile: ProfileSummary
  tokens: ProfileTokens
}

interface ExportedSettingsV1 {
  format: 'codex-switch-profile-export'
  version: 1
  exportedAt: string
  activeProfileId?: string
  lastProfileId?: string
  profiles: ExportedProfileEntryV1[]
}

interface ImportProfilesResult {
  created: number
  updated: number
  skipped: number
}

interface ParsedImportEntry {
  sourceProfileId?: string
  name: string
  authData: AuthData
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const v = value.trim()
  return v ? v : undefined
}

export class ProfileManager {
  constructor(private context: vscode.ExtensionContext) {}

  private lastSyncedProfileId: string | undefined
  private readonly renewLeaseOwner = `${os.hostname()}:${process.pid}:${randomUUID()}`

  private getConfiguredStorageMode(): StorageMode {
    const cfg = vscode.workspace.getConfiguration('codexSwitch')
    const raw = cfg.get<StorageMode>('storageMode', 'auto')
    if (raw === 'secretStorage' || raw === 'remoteFiles' || raw === 'auto') {
      return raw
    }
    return 'auto'
  }

  private getResolvedStorageMode(): Exclude<StorageMode, 'auto'> {
    const configured = this.getConfiguredStorageMode()
    if (configured === 'auto') {
      return vscode.env.remoteName === 'ssh-remote'
        ? 'remoteFiles'
        : 'secretStorage'
    }
    return configured
  }

  private isRemoteFilesMode(): boolean {
    return this.getResolvedStorageMode() === 'remoteFiles'
  }

  isWorkspaceSpecificCodexHomeConfigured(): boolean {
    return vscode.workspace
      .getConfiguration('codexSwitch')
      .get<boolean>('workspaceSpecificCodexHome', true)
  }

  private normalizeEmail(email: string | undefined): string {
    return String(email || '')
      .trim()
      .toLowerCase()
  }

  private normalizeIdentity(value: string | undefined): string {
    return String(value || '').trim()
  }

  private compareIdentityField(
    profileValue: string | undefined,
    authValue: string | undefined,
  ): boolean | undefined {
    const p = this.normalizeIdentity(profileValue)
    const a = this.normalizeIdentity(authValue)
    if (!p || !a) {
      return undefined
    }
    return p === a
  }

  private matchesAuth(profile: ProfileSummary, authData: AuthData): boolean {
    const hasProfileOrganizationId = Boolean(
      this.normalizeIdentity(profile.defaultOrganizationId),
    )
    const hasAuthOrganizationId = Boolean(
      this.normalizeIdentity(authData.defaultOrganizationId),
    )
    const organizationIdMatch = this.compareIdentityField(
      profile.defaultOrganizationId,
      authData.defaultOrganizationId,
    )

    // Team/Business tenants can share account_id across different users.
    // Match by user identity fields first.
    // If identity matches and both sides know the selected workspace/org, require it too.
    const identityMatches = [
      this.compareIdentityField(profile.chatgptUserId, authData.chatgptUserId),
      this.compareIdentityField(profile.userId, authData.userId),
      this.compareIdentityField(profile.subject, authData.subject),
    ].filter((v): v is boolean => v !== undefined)

    if (identityMatches.length > 0) {
      if (identityMatches.some((v) => !v)) {
        return false
      }
      if (hasProfileOrganizationId || hasAuthOrganizationId) {
        // If workspace is known only on one side, avoid collapsing profiles.
        if (organizationIdMatch === undefined) {
          return false
        }
        return organizationIdMatch
      }
      return true
    }

    const pe = this.normalizeEmail(profile.email)
    const ae = this.normalizeEmail(authData.email)
    const hasComparableEmail =
      Boolean(pe) && Boolean(ae) && pe !== 'unknown' && ae !== 'unknown'
    const hasComparableAccountId =
      Boolean(authData.accountId) && Boolean(profile.accountId)
    const accountIdMatch = hasComparableAccountId
      ? authData.accountId === profile.accountId
      : false
    const hasComparableOrganizationId = organizationIdMatch !== undefined

    if (
      (hasProfileOrganizationId || hasAuthOrganizationId) &&
      !hasComparableOrganizationId
    ) {
      // Workspace is known only on one side: treat as distinct to avoid false matches.
      return false
    }

    if (
      hasComparableEmail &&
      hasComparableAccountId &&
      hasComparableOrganizationId
    ) {
      return pe === ae && accountIdMatch && organizationIdMatch === true
    }

    if (hasComparableEmail && hasComparableOrganizationId) {
      return pe === ae && organizationIdMatch === true
    }

    if (hasComparableEmail && hasComparableAccountId) {
      return pe === ae && accountIdMatch
    }

    if (hasComparableAccountId && hasComparableOrganizationId) {
      return accountIdMatch && organizationIdMatch === true
    }

    if (hasComparableEmail) {
      return pe === ae
    }

    return false
  }

  private getStorageDir(): string {
    if (this.isRemoteFilesMode()) {
      return getSharedStoreRoot()
    }
    return this.context.globalStorageUri.fsPath
  }

  private getProfilesPath(): string {
    if (this.isRemoteFilesMode()) {
      return getSharedProfilesPath()
    }
    return path.join(this.getStorageDir(), PROFILES_FILENAME)
  }

  private ensureStorageDir() {
    if (this.isRemoteFilesMode()) {
      ensureSharedStoreDirs()
      return
    }

    const dir = this.getStorageDir()
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  private parseProfilesFile(raw: string): ProfilesFileV1 {
    const parsed: any = JSON.parse(raw)

    // Legacy format: plain array of profiles.
    if (Array.isArray(parsed)) {
      return { version: 1, profiles: parsed as ProfileSummary[] }
    }

    // Legacy format: { profiles: [...] } without a version.
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.profiles)
    ) {
      return { version: 1, profiles: parsed.profiles as ProfileSummary[] }
    }

    // Current format: { version: 1, profiles: [...] }
    if (parsed && parsed.version === 1 && Array.isArray(parsed.profiles)) {
      return { version: 1, profiles: parsed.profiles as ProfileSummary[] }
    }

    return { version: 1, profiles: [] }
  }

  private async readProfilesFile(): Promise<ProfilesFileV1> {
    this.ensureStorageDir()
    const filePath = this.getProfilesPath()
    if (!fs.existsSync(filePath)) {
      return { version: 1, profiles: [] }
    }

    try {
      if (this.isRemoteFilesMode()) {
        const parsed = readJsonFile<any>(filePath)
        if (parsed == null) {
          return { version: 1, profiles: [] }
        }
        return this.parseProfilesFile(JSON.stringify(parsed))
      }
      const raw = fs.readFileSync(filePath, 'utf8')
      return this.parseProfilesFile(raw)
    } catch {
      // If corrupted, don't crash the extension.
      return { version: 1, profiles: [] }
    }
  }

  private writeProfilesFile(data: ProfilesFileV1) {
    this.ensureStorageDir()
    if (this.isRemoteFilesMode()) {
      writeJsonFile(this.getProfilesPath(), data)
      return
    }

    fs.writeFileSync(this.getProfilesPath(), JSON.stringify(data, null, 2), {
      encoding: 'utf8',
    })
  }

  private secretKey(profileId: string): string {
    return `${NEW_SECRET_PREFIX}${profileId}`
  }

  private legacySecretKey(profileId: string): string {
    return `${OLD_SECRET_PREFIX}${profileId}`
  }

  private readSharedActiveProfile(): SharedActiveProfile | null {
    if (!this.isRemoteFilesMode()) {
      return null
    }
    return readJsonFile<SharedActiveProfile>(getSharedActiveProfilePath())
  }

  private writeSharedActiveProfile(profileId: string): void {
    if (!this.isRemoteFilesMode()) {
      return
    }
    writeJsonFile(getSharedActiveProfilePath(), {
      profileId,
      updatedAt: new Date().toISOString(),
    } satisfies SharedActiveProfile)
  }

  private deleteSharedActiveProfile(): void {
    if (!this.isRemoteFilesMode()) {
      return
    }
    deleteFileIfExists(getSharedActiveProfilePath())
  }

  private async clearStateKey(
    bucket: vscode.Memento,
    key: string,
  ): Promise<void> {
    if (typeof bucket.get<string>(key) === 'undefined') {
      return
    }
    await bucket.update(key, undefined)
  }

  private async clearRetiredLocalState(
    _currentKey: string,
    legacyKey: string,
  ): Promise<void> {
    // Clear only legacy-named keys; the current key in workspaceState is our
    // per-window source of truth and must not be wiped here.
    await this.clearStateKey(this.context.workspaceState, legacyKey)
    await this.clearStateKey(this.context.globalState, legacyKey)
  }

  getWorkspaceCodexHome(): string | undefined {
    if (!this.isWorkspaceSpecificCodexHomeConfigured()) {
      return undefined
    }
    if (this.isRemoteFilesMode()) {
      return undefined
    }
    if (!this.context.storageUri) {
      return undefined
    }
    // Place the workspace-specific CODEX_HOME inside the extension's own
    // workspace storage directory. VS Code guarantees this path is unique per
    // workspace+extension and stable for the lifetime of the workspace, with
    // no dependency on internal VS Code path structure.
    return path.join(this.context.storageUri.fsPath, '.codex')
  }

  getRuntimeAuthPath(): string {
    // Keep every command and recovery path on the same resolver. Mixing this
    // workspace path with getDefaultCodexAuthPath() is the bug that made
    // profile actions read ~/.codex/auth.json while the window was supposed to
    // operate on its workspace-specific runtime.
    const wsHome = this.getWorkspaceCodexHome()
    if (wsHome) {
      return path.join(wsHome, 'auth.json')
    }
    return getDefaultCodexAuthPath()
  }

  async initWorkspaceAuth(sourceAuthPath?: string): Promise<void> {
    if (this.isRemoteFilesMode()) {
      return
    }
    const wsHome = this.getWorkspaceCodexHome()
    if (!wsHome) {
      return
    }
    const wsAuthPath = path.join(wsHome, 'auth.json')
    if (fs.existsSync(wsAuthPath)) {
      return
    }
    const globalAuthPath = sourceAuthPath || getDefaultCodexAuthPath()
    // Activation passes the inherited auth path captured before CODEX_HOME is
    // redirected to the workspace. If a caller skips that capture and the paths
    // are already identical, copying would be a no-op at best and misleading at
    // worst.
    if (path.resolve(globalAuthPath) === path.resolve(wsAuthPath)) {
      return
    }
    if (!fs.existsSync(globalAuthPath)) {
      return
    }
    try {
      fs.mkdirSync(wsHome, { recursive: true })
      fs.copyFileSync(globalAuthPath, wsAuthPath)
    } catch {
      // Non-fatal: login/import commands can still populate the workspace auth
      // file, so activation should not fail the entire extension.
    }
  }

  private syncRuntimeAuth(authData: AuthData, profileId: string): void {
    syncCodexAuthFile(this.getRuntimeAuthPath(), authData)
    this.lastSyncedProfileId = profileId
  }

  private async readMigratedLocalState(
    currentKey: string,
    legacyKey: string,
  ): Promise<string | undefined> {
    const workspaceBucket = this.context.workspaceState
    const globalBucket = this.context.globalState

    // Primary source of truth: per-workspace storage (one value per window).
    const workspaceValue = workspaceBucket.get<string>(currentKey)
    if (workspaceValue) {
      await this.clearRetiredLocalState(currentKey, legacyKey)
      return workspaceValue
    }

    // One-time migration: promote a value written by older extension versions
    // (which used globalState) into this window's workspaceState so the choice
    // is preserved after upgrading. Global state is left untouched so other
    // workspace windows can perform the same migration independently.
    const globalValue = globalBucket.get<string>(currentKey)
    if (globalValue) {
      await workspaceBucket.update(currentKey, globalValue)
      await this.clearRetiredLocalState(currentKey, legacyKey)
      return globalValue
    }

    // Legacy key fallback — workspace scope first, then global.
    const workspaceLegacy = workspaceBucket.get<string>(legacyKey)
    if (workspaceLegacy) {
      await workspaceBucket.update(currentKey, workspaceLegacy)
      await this.clearRetiredLocalState(currentKey, legacyKey)
      return workspaceLegacy
    }

    const globalLegacy = globalBucket.get<string>(legacyKey)
    if (!globalLegacy) {
      return undefined
    }

    await workspaceBucket.update(currentKey, globalLegacy)
    await this.clearRetiredLocalState(currentKey, legacyKey)
    return globalLegacy
  }

  private async writeLocalState(
    currentKey: string,
    legacyKey: string,
    value: string | undefined,
  ): Promise<void> {
    await this.context.workspaceState.update(currentKey, value)
    await this.clearRetiredLocalState(currentKey, legacyKey)
  }

  private async getPersistedActiveProfileId(): Promise<string | undefined> {
    if (this.isRemoteFilesMode()) {
      return this.readSharedActiveProfile()?.profileId
    }

    return this.readMigratedLocalState(
      ACTIVE_PROFILE_KEY,
      OLD_ACTIVE_PROFILE_KEY,
    )
  }

  private buildRuntimeWarningMessage(
    profiles: ProfileSummary[],
    persistedActiveProfileId: string | undefined,
    runtimeState: RuntimeSession['kind'],
    matchedProfileId?: string,
  ): string | undefined {
    const persistedProfile = persistedActiveProfileId
      ? profiles.find((profile) => profile.id === persistedActiveProfileId)
      : undefined

    if (runtimeState === 'matchedProfile') {
      if (
        persistedProfile &&
        matchedProfileId &&
        persistedProfile.id !== matchedProfileId
      ) {
        const runtimeProfile = profiles.find(
          (profile) => profile.id === matchedProfileId,
        )
        return vscode.l10n.t(
          'Runtime auth currently matches "{0}", but the saved active selection still points to "{1}".',
          runtimeProfile
            ? getProfilePrimaryLabel(runtimeProfile)
            : matchedProfileId,
          getProfilePrimaryLabel(persistedProfile),
        )
      }
      return undefined
    }

    if (runtimeState === 'externalAuth') {
      if (persistedProfile) {
        return vscode.l10n.t(
          'Runtime auth does not match the saved active profile "{0}". Codex is using an external auth.json session.',
          getProfilePrimaryLabel(persistedProfile),
        )
      }
      return vscode.l10n.t(
        'Codex is currently using auth.json data that is not saved as a profile.',
      )
    }

    if (persistedProfile) {
      return vscode.l10n.t(
        'Saved active profile "{0}" exists, but the runtime auth.json file is missing or invalid.',
        getProfilePrimaryLabel(persistedProfile),
      )
    }

    return undefined
  }

  private buildMatchedRuntimeSession(
    profiles: ProfileSummary[],
    persistedActiveProfileId: string | undefined,
    authPath: string,
    authData: AuthData,
    matchedProfileId: string,
  ): RuntimeSession {
    return {
      kind: 'matchedProfile',
      authPath,
      authData,
      matchedProfileId,
      warningMessage: this.buildRuntimeWarningMessage(
        profiles,
        persistedActiveProfileId,
        'matchedProfile',
        matchedProfileId,
      ),
    }
  }

  private async restorePersistedActiveRuntimeAuth(
    profiles: ProfileSummary[],
    persistedActiveProfileId: string | undefined,
    authPath: string,
    matchedProfileId?: string,
  ): Promise<RuntimeSession | undefined> {
    if (this.isRemoteFilesMode() || !persistedActiveProfileId) {
      return undefined
    }

    if (matchedProfileId === persistedActiveProfileId) {
      return undefined
    }

    const persistedProfile = profiles.find(
      (profile) => profile.id === persistedActiveProfileId,
    )
    if (!persistedProfile) {
      return undefined
    }

    const persistedAuthData = await this.loadAuthData(persistedProfile.id)
    if (!persistedAuthData) {
      return undefined
    }

    // In local storage mode the workspaceState selection is the durable owner
    // of this workspace's runtime auth. The auth.json file is only a runtime
    // projection consumed by Codex terminals, so it can drift after first-open
    // global seeding, deletion, invalid edits, or another saved profile being
    // written into the same workspace. Restore it from the saved profile
    // instead of letting a stale runtime copy silently redefine the workspace
    // selection.
    this.syncRuntimeAuth(persistedAuthData, persistedProfile.id)

    return {
      kind: 'matchedProfile',
      authPath,
      authData: persistedAuthData,
      matchedProfileId: persistedProfile.id,
    }
  }

  async getRuntimeSession(
    profiles?: ProfileSummary[],
  ): Promise<RuntimeSession> {
    const resolvedProfiles = profiles || (await this.listProfiles())
    const authPath = this.getRuntimeAuthPath()
    const authData = await loadAuthDataFromFile(authPath)
    const persistedActiveProfileId = await this.getPersistedActiveProfileId()

    if (authData) {
      const match = resolvedProfiles.find((profile) =>
        this.matchesAuth(profile, authData),
      )
      if (match) {
        const restoredSession = await this.restorePersistedActiveRuntimeAuth(
          resolvedProfiles,
          persistedActiveProfileId,
          authPath,
          match.id,
        )
        if (restoredSession) {
          return restoredSession
        }

        if (this.isRemoteFilesMode()) {
          const sharedActiveProfile = this.readSharedActiveProfile()
          if (sharedActiveProfile?.profileId !== match.id) {
            this.writeSharedActiveProfile(match.id)
          }
        }

        return this.buildMatchedRuntimeSession(
          resolvedProfiles,
          persistedActiveProfileId,
          authPath,
          authData,
          match.id,
        )
      }

      // A valid auth.json that does not match any saved profile is usually a
      // fresh `codex login` session. Keep it visible as external auth so the
      // user can import or replace a profile instead of losing that new login.
      return {
        kind: 'externalAuth',
        authPath,
        authData,
        warningMessage: this.buildRuntimeWarningMessage(
          resolvedProfiles,
          persistedActiveProfileId,
          'externalAuth',
        ),
      }
    }

    const restoredSession = await this.restorePersistedActiveRuntimeAuth(
      resolvedProfiles,
      persistedActiveProfileId,
      authPath,
    )
    if (restoredSession) {
      return restoredSession
    }

    return {
      kind: 'noAuth',
      authPath,
      authData: null,
      warningMessage: this.buildRuntimeWarningMessage(
        resolvedProfiles,
        persistedActiveProfileId,
        'noAuth',
      ),
    }
  }

  private readRemoteProfileTokens(profileId: string): ProfileTokens | null {
    return readJsonFile<ProfileTokens>(getSharedProfileSecretsPath(profileId))
  }

  private async readStoredTokens(
    profileId: string,
  ): Promise<ProfileTokens | null> {
    if (this.isRemoteFilesMode()) {
      return this.readRemoteProfileTokens(profileId)
    }

    const raw =
      (await this.context.secrets.get(this.secretKey(profileId))) ||
      (await this.context.secrets.get(this.legacySecretKey(profileId)))
    if (!raw) {
      return null
    }

    try {
      return JSON.parse(raw) as ProfileTokens
    } catch {
      return null
    }
  }

  private async writeStoredTokens(
    profileId: string,
    tokens: ProfileTokens,
  ): Promise<void> {
    if (this.isRemoteFilesMode()) {
      ensureSharedStoreDirs()
      writeJsonFile(getSharedProfileSecretsPath(profileId), tokens)
      return
    }

    await this.context.secrets.store(
      this.secretKey(profileId),
      JSON.stringify(tokens),
    )
  }

  private async deleteStoredTokens(profileId: string): Promise<void> {
    if (this.isRemoteFilesMode()) {
      deleteFileIfExists(getSharedProfileSecretsPath(profileId))
      return
    }

    await this.context.secrets.delete(this.secretKey(profileId))
    await this.context.secrets.delete(this.legacySecretKey(profileId))
  }

  private getGlobalStorageRoot(): string {
    // .../User/globalStorage/<publisher.name> -> .../User/globalStorage
    return path.dirname(this.context.globalStorageUri.fsPath)
  }

  private async tryMigrateLegacyProfilesOnce(): Promise<void> {
    if (this.context.globalState.get<boolean>(MIGRATED_LEGACY_KEY)) {
      return
    }

    const current = await this.readProfilesFile()
    if (current.profiles.length > 0) {
      await this.context.globalState.update(MIGRATED_LEGACY_KEY, true)
      return
    }

    const root = this.getGlobalStorageRoot()
    if (!fs.existsSync(root)) {
      await this.context.globalState.update(MIGRATED_LEGACY_KEY, true)
      return
    }

    const currentDirName = path.basename(this.getStorageDir())
    const candidates: string[] = []

    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) {
          continue
        }
        const name = e.name
        if (name === currentDirName) {
          continue
        }
        if (!name.endsWith('.codex-switch') && !name.endsWith('.codex-stats')) {
          continue
        }
        candidates.push(name)
      }
    } catch {
      await this.context.globalState.update(MIGRATED_LEGACY_KEY, true)
      return
    }

    // Prefer older ids we used during development.
    candidates.sort((a, b) => {
      const rank = (n: string) => {
        if (n.toLowerCase().includes('codex-switch')) {
          return 0
        }
        if (n.toLowerCase().includes('codex-stats')) {
          return 1
        }
        return 2
      }
      return rank(a) - rank(b)
    })

    for (const dirName of candidates) {
      const legacyProfilesPath = path.join(root, dirName, PROFILES_FILENAME)
      if (!fs.existsSync(legacyProfilesPath)) {
        continue
      }

      try {
        const raw = fs.readFileSync(legacyProfilesPath, 'utf8')
        const legacy = this.parseProfilesFile(raw)
        if (!legacy.profiles || legacy.profiles.length === 0) {
          continue
        }

        // Only migrate the profile list. Tokens are stored in SecretStorage and cannot be
        // read across extension ids.
        this.writeProfilesFile({ version: 1, profiles: legacy.profiles })

        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            'Found profiles from a previous install. Please re-import auth.json for each profile to restore tokens.',
          ),
        )
        break
      } catch {
        // keep trying other candidates
      }
    }

    await this.context.globalState.update(MIGRATED_LEGACY_KEY, true)
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    await this.tryMigrateLegacyProfilesOnce()
    const file = await this.readProfilesFile()
    return [...file.profiles].sort((a, b) =>
      getProfilePrimaryLabel(a).localeCompare(getProfilePrimaryLabel(b)),
    )
  }

  async getProfile(profileId: string): Promise<ProfileSummary | undefined> {
    const profiles = await this.listProfiles()
    return profiles.find((p) => p.id === profileId)
  }

  async exportProfilesForTransfer(): Promise<{
    data: ExportedSettingsV1
    skipped: number
  }> {
    const profiles = await this.listProfiles()
    const activeProfileId = await this.getPersistedActiveProfileId()
    const lastProfileId = await this.getLastProfileId()

    const exportedProfiles: ExportedProfileEntryV1[] = []
    let skipped = 0

    for (const profile of profiles) {
      const tokens = await this.readStoredTokens(profile.id)
      if (!tokens) {
        skipped += 1
        continue
      }
      exportedProfiles.push({ profile, tokens })
    }

    const data: ExportedSettingsV1 = {
      format: 'codex-switch-profile-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      activeProfileId,
      lastProfileId,
      profiles: exportedProfiles,
    }

    return { data, skipped }
  }

  private parseImportEntry(value: unknown): ParsedImportEntry | null {
    const entry = asObject(value)
    if (!entry) {
      return null
    }

    const profile = asObject(entry.profile)
    const tokens = asObject(entry.tokens)
    if (!profile || !tokens) {
      return null
    }

    const idToken = asOptionalString(tokens.idToken)
    const accessToken = asOptionalString(tokens.accessToken)
    const refreshToken = asOptionalString(tokens.refreshToken)
    if (!idToken || !accessToken || !refreshToken) {
      return null
    }

    const email = asOptionalString(profile.email) || 'Unknown'
    const planType = asOptionalString(profile.planType) || 'Unknown'
    const name =
      asOptionalString(profile.name) ||
      (email !== 'Unknown' ? email.split('@')[0] : undefined) ||
      'profile'

    const authJson = asObject(tokens.authJson) || undefined
    const accountId =
      asOptionalString(tokens.accountId) || asOptionalString(profile.accountId)

    return {
      sourceProfileId: asOptionalString(profile.id),
      name,
      authData: {
        idToken,
        accessToken,
        refreshToken,
        accountId,
        defaultOrganizationId: asOptionalString(profile.defaultOrganizationId),
        defaultOrganizationTitle: asOptionalString(
          profile.defaultOrganizationTitle,
        ),
        chatgptUserId: asOptionalString(profile.chatgptUserId),
        userId: asOptionalString(profile.userId),
        subject: asOptionalString(profile.subject),
        email,
        planType,
        authJson,
      },
    }
  }

  async importProfilesFromTransfer(
    value: unknown,
  ): Promise<ImportProfilesResult> {
    const payload = asObject(value)
    if (!payload) {
      throw new Error('Invalid settings file format.')
    }

    const format = asOptionalString(payload.format)
    if (format !== 'codex-switch-profile-export') {
      throw new Error('Unsupported settings file format.')
    }

    if (payload.version !== 1) {
      throw new Error('Unsupported settings export version.')
    }

    if (!Array.isArray(payload.profiles)) {
      throw new Error('Invalid settings file: profiles must be an array.')
    }

    const sourceToTargetId = new Map<string, string>()
    let created = 0
    let updated = 0
    let skipped = 0

    for (const rawEntry of payload.profiles) {
      const parsed = this.parseImportEntry(rawEntry)
      if (!parsed) {
        skipped += 1
        continue
      }

      const duplicate = await this.findDuplicateProfile(parsed.authData)
      if (duplicate) {
        await this.replaceProfileAuth(duplicate.id, parsed.authData)
        if (parsed.sourceProfileId) {
          sourceToTargetId.set(parsed.sourceProfileId, duplicate.id)
        }
        updated += 1
        continue
      }

      const createdProfile = await this.createProfile(
        parsed.name,
        parsed.authData,
      )
      if (parsed.sourceProfileId) {
        sourceToTargetId.set(parsed.sourceProfileId, createdProfile.id)
      }
      created += 1
    }

    const importedActiveProfileId = asOptionalString(payload.activeProfileId)
    if (importedActiveProfileId) {
      const targetId = sourceToTargetId.get(importedActiveProfileId)
      if (targetId) {
        await this.setActiveProfileId(targetId)
      }
    }

    const importedLastProfileId = asOptionalString(payload.lastProfileId)
    if (importedLastProfileId) {
      const targetId = sourceToTargetId.get(importedLastProfileId)
      if (targetId) {
        await this.setLastProfileId(targetId)
      }
    }

    return { created, updated, skipped }
  }

  async findDuplicateProfile(
    authData: AuthData,
  ): Promise<ProfileSummary | undefined> {
    const file = await this.readProfilesFile()
    return file.profiles.find((p) => this.matchesAuth(p, authData))
  }

  private async recoverMissingTokens(
    profileId: string,
  ): Promise<AuthData | null> {
    const profile = await this.getProfile(profileId)
    const recoverLabel = vscode.l10n.t('Recover from remote store')
    const importLabel = vscode.l10n.t('Import current runtime auth.json')
    const deleteLabel = vscode.l10n.t('Delete broken profile')

    const canRecoverFromRemote =
      !this.isRemoteFilesMode() &&
      this.readRemoteProfileTokens(profileId) != null

    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Profile "{0}" is missing tokens. Restore it before switching.',
        profile?.name || profileId,
      ),
      { modal: true },
      ...(canRecoverFromRemote ? [recoverLabel] : []),
      importLabel,
      deleteLabel,
    )

    if (pick === recoverLabel) {
      const tokens = this.readRemoteProfileTokens(profileId)
      if (tokens) {
        await this.writeStoredTokens(profileId, tokens)
        return this.loadAuthData(profileId)
      }
    }

    if (pick === importLabel) {
      const authPath = this.getRuntimeAuthPath()
      const authData = await loadAuthDataFromFile(authPath)
      if (!authData) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'Could not read auth from {0}. Run "codex login" first.',
            authPath,
          ),
        )
        return null
      }
      await this.replaceProfileAuth(profileId, authData)
      return authData
    }

    if (pick === deleteLabel) {
      await this.deleteProfile(profileId)
    }

    return null
  }

  async replaceProfileAuth(
    profileId: string,
    authData: AuthData,
  ): Promise<boolean> {
    const file = await this.readProfilesFile()
    const idx = file.profiles.findIndex((p) => p.id === profileId)
    if (idx === -1) {
      return false
    }

    file.profiles[idx] = {
      ...file.profiles[idx],
      email: authData.email,
      planType: authData.planType,
      accountId: authData.accountId,
      defaultOrganizationId: authData.defaultOrganizationId,
      defaultOrganizationTitle: authData.defaultOrganizationTitle,
      chatgptUserId: authData.chatgptUserId,
      userId: authData.userId,
      subject: authData.subject,
      updatedAt: new Date().toISOString(),
    }
    this.writeProfilesFile(file)

    const tokens: ProfileTokens = {
      idToken: authData.idToken,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      accountId: authData.accountId,
      authJson: authData.authJson,
    }
    await this.writeStoredTokens(profileId, tokens)
    return true
  }

  async updateStoredProfileAuth(
    profileId: string,
    authData: AuthData,
    options?: { syncIfActive?: boolean },
  ): Promise<boolean> {
    const updated = await this.replaceProfileAuth(profileId, authData)
    if (!updated) {
      return false
    }

    if (!options?.syncIfActive) {
      return true
    }

    const activeProfileId = await this.getActiveProfileId()
    if (activeProfileId !== profileId) {
      return true
    }

    // The active local profile owns this window's runtime auth projection.
    // Keeping this sync eager ensures background token renewal cannot leave the
    // workspace auth.json behind the saved profile token payload.
    this.syncRuntimeAuth(authData, profileId)
    return true
  }

  async createProfile(
    name: string,
    authData: AuthData,
  ): Promise<ProfileSummary> {
    const now = new Date().toISOString()
    const id = randomUUID()

    const profile: ProfileSummary = {
      id,
      name,
      email: authData.email,
      planType: authData.planType,
      accountId: authData.accountId,
      defaultOrganizationId: authData.defaultOrganizationId,
      defaultOrganizationTitle: authData.defaultOrganizationTitle,
      chatgptUserId: authData.chatgptUserId,
      userId: authData.userId,
      subject: authData.subject,
      createdAt: now,
      updatedAt: now,
    }

    const file = await this.readProfilesFile()
    file.profiles.push(profile)
    this.writeProfilesFile(file)

    const tokens: ProfileTokens = {
      idToken: authData.idToken,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      accountId: authData.accountId,
      authJson: authData.authJson,
    }
    await this.writeStoredTokens(id, tokens)

    return profile
  }

  async renameProfile(profileId: string, newName: string): Promise<boolean> {
    const file = await this.readProfilesFile()
    const idx = file.profiles.findIndex((p) => p.id === profileId)
    if (idx === -1) {
      return false
    }
    file.profiles[idx] = {
      ...file.profiles[idx],
      name: newName,
      updatedAt: new Date().toISOString(),
    }
    this.writeProfilesFile(file)
    return true
  }

  async deleteProfile(profileId: string): Promise<boolean> {
    const file = await this.readProfilesFile()
    const before = file.profiles.length
    file.profiles = file.profiles.filter((p) => p.id !== profileId)
    if (file.profiles.length === before) {
      return false
    }
    this.writeProfilesFile(file)

    await this.deleteStoredTokens(profileId)

    // Clean up active/last if they point to deleted profile.
    const active = await this.getPersistedActiveProfileId()
    const last = await this.getLastProfileId()
    if (active === profileId) {
      await this.setActiveProfileId(undefined)
    }
    if (last === profileId) {
      await this.setLastProfileId(undefined)
    }
    return true
  }

  async loadAuthData(profileId: string): Promise<AuthData | null> {
    const profile = await this.getProfile(profileId)
    if (!profile) {
      return null
    }

    const tokens = await this.readStoredTokens(profileId)
    if (!tokens) {
      return null
    }

    return {
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountId: tokens.accountId || profile.accountId,
      defaultOrganizationId: profile.defaultOrganizationId,
      defaultOrganizationTitle: profile.defaultOrganizationTitle,
      chatgptUserId: profile.chatgptUserId,
      userId: profile.userId,
      subject: profile.subject,
      email: profile.email,
      planType: profile.planType,
      authJson: tokens.authJson,
    }
  }

  isUsingRemoteFilesStorage(): boolean {
    return this.isRemoteFilesMode()
  }

  async withProfileRenewLease<T>(
    profileId: string,
    task: () => Promise<T>,
  ): Promise<{ acquired: boolean; value?: T }> {
    // Use file-based lease in all storage modes to prevent simultaneous token
    // renewal across multiple VS Code windows (each window runs its own timer).
    // Remote mode already relied on this; local secretStorage mode previously
    // skipped it, causing redundant concurrent renewals and token-rotation races.
    const leasePath = getSharedProfileRenewLeasePath(profileId)
    const acquired = acquireJsonLease(
      leasePath,
      this.renewLeaseOwner,
      PROFILE_RENEW_LEASE_TTL_MS,
    )
    if (!acquired) {
      return { acquired: false }
    }

    try {
      return {
        acquired: true,
        value: await task(),
      }
    } finally {
      releaseJsonLease(leasePath, this.renewLeaseOwner)
    }
  }

  async getActiveProfileId(): Promise<string | undefined> {
    const runtimeSession = await this.getRuntimeSession()
    return runtimeSession.kind === 'matchedProfile'
      ? runtimeSession.matchedProfileId
      : undefined
  }

  async setActiveProfileId(profileId: string | undefined): Promise<boolean> {
    const prev = await this.getActiveProfileId()

    let authData: AuthData | null = null
    if (profileId) {
      authData = await this.loadAuthData(profileId)
      if (!authData) {
        authData = await this.recoverMissingTokens(profileId)
        if (!authData) {
          return false
        }
      }
    }

    if (prev && profileId && prev !== profileId) {
      await this.setLastProfileId(prev)
    }

    if (this.isRemoteFilesMode()) {
      if (profileId) {
        this.writeSharedActiveProfile(profileId)
      } else {
        this.deleteSharedActiveProfile()
      }
    } else {
      await this.writeLocalState(
        ACTIVE_PROFILE_KEY,
        OLD_ACTIVE_PROFILE_KEY,
        profileId,
      )
    }

    if (profileId && authData) {
      // The profile auth payload is already in memory here, so sync it
      // directly instead of paying for another token lookup before writing the
      // runtime auth file.
      this.syncRuntimeAuth(authData, profileId)
    }
    return true
  }

  async getLastProfileId(): Promise<string | undefined> {
    return this.readMigratedLocalState(LAST_PROFILE_KEY, OLD_LAST_PROFILE_KEY)
  }

  private async setLastProfileId(profileId: string | undefined): Promise<void> {
    await this.writeLocalState(
      LAST_PROFILE_KEY,
      OLD_LAST_PROFILE_KEY,
      profileId,
    )
  }

  async toggleLastProfileId(): Promise<string | undefined> {
    const active = await this.getActiveProfileId()
    const last = await this.getLastProfileId()
    if (!last) {
      return undefined
    }

    const ok = await this.setActiveProfileId(last)
    if (ok && active) {
      // Swap so a second click toggles back.
      await this.setLastProfileId(active)
    }
    return ok ? last : undefined
  }

  createWatchers(
    onChanged: () => void,
    inheritedAuthPath?: string,
  ): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = []
    const fire = () => {
      try {
        onChanged()
      } catch {
        // ignore refresh errors from file watchers
      }
    }

    const inheritedRuntimeAuthPath = inheritedAuthPath || getDefaultCodexAuthPath()
    const globalAuthDir = path.dirname(inheritedRuntimeAuthPath)
    const authWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(globalAuthDir), 'auth.json'),
    )
    authWatcher.onDidCreate(fire)
    authWatcher.onDidChange(fire)
    authWatcher.onDidDelete(fire)
    disposables.push(authWatcher)

    // Also watch the workspace-specific auth.json for per-window isolation.
    const wsAuthPath = this.getRuntimeAuthPath()
    const wsAuthDir = path.dirname(wsAuthPath)
    if (wsAuthDir !== globalAuthDir) {
      const wsAuthWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(wsAuthDir), 'auth.json'),
      )
      wsAuthWatcher.onDidCreate(fire)
      wsAuthWatcher.onDidChange(fire)
      wsAuthWatcher.onDidDelete(fire)
      disposables.push(wsAuthWatcher)
    }

    if (this.isRemoteFilesMode()) {
      const profilesWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(getSharedStoreRoot()),
          PROFILES_FILENAME,
        ),
      )
      profilesWatcher.onDidCreate(fire)
      profilesWatcher.onDidChange(fire)
      profilesWatcher.onDidDelete(fire)
      disposables.push(profilesWatcher)

      const activeWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(getSharedStoreRoot()),
          SHARED_ACTIVE_PROFILE_FILENAME,
        ),
      )
      activeWatcher.onDidCreate(fire)
      activeWatcher.onDidChange(fire)
      activeWatcher.onDidDelete(fire)
      disposables.push(activeWatcher)

      const tokenWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(getSharedProfilesDir()),
          '*.json',
        ),
      )
      tokenWatcher.onDidCreate(fire)
      tokenWatcher.onDidChange(fire)
      tokenWatcher.onDidDelete(fire)
      disposables.push(tokenWatcher)
    }

    return disposables
  }
}
