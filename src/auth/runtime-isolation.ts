import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import {
  IsolatedLaunchCommand,
  RuntimeIsolationMode,
  RuntimeIsolationStatus,
  WorkspaceIsolationDescriptor,
  WorkspaceLaunchTarget,
} from '../types'
import { SHARED_STORE_DIRNAME } from './shared-profile-store'

export const ISOLATED_INSTANCE_KEY_ENV = 'CODEX_SWITCH_ISOLATED_WORKSPACE_KEY'
export const ISOLATED_INSTANCE_USER_DATA_ENV =
  'CODEX_SWITCH_ISOLATED_USER_DATA_DIR'
const ISOLATED_INSTANCES_DIRNAME = 'isolated-workspaces'

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function getConfiguredActiveProfileScope(): 'global' | 'workspace' {
  const newCfg = vscode.workspace.getConfiguration('codexSwitch')
  const next = newCfg.get<'global' | 'workspace'>('activeProfileScope')
  if (next === 'workspace' || next === 'global') {
    return next
  }

  return vscode.workspace
    .getConfiguration('codexUsage')
    .get<'global' | 'workspace'>('activeProfileScope', 'global')
}

export function getRuntimeIsolationMode(): RuntimeIsolationMode {
  const raw = vscode.workspace
    .getConfiguration('codexSwitch')
    .get<RuntimeIsolationMode>('runtimeIsolationMode', 'sharedRuntime')
  return raw === 'isolatedInstance' ? 'isolatedInstance' : 'sharedRuntime'
}

export function getEffectiveActiveProfileScope(): 'global' | 'workspace' {
  if (getRuntimeIsolationMode() !== 'isolatedInstance') {
    return 'global'
  }
  return getConfiguredActiveProfileScope()
}

export function isWorkspaceScopeIgnored(): boolean {
  return (
    getRuntimeIsolationMode() !== 'isolatedInstance' &&
    getConfiguredActiveProfileScope() === 'workspace'
  )
}

function getIsolationRoot(): string {
  return path.join(
    os.homedir(),
    SHARED_STORE_DIRNAME,
    ISOLATED_INSTANCES_DIRNAME,
  )
}

function sanitizeLabel(label: string): string {
  const next = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return next || 'window'
}

function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPathInsideOrEqual(parent: string, child: string): boolean {
  const normalizedParent = normalizeComparablePath(parent)
  const normalizedChild = normalizeComparablePath(child)
  const relative = path.relative(normalizedParent, normalizedChild)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

function getUriKey(value: vscode.Uri): string {
  if (value.scheme === 'file') {
    return value.fsPath
  }
  return value.toString(true)
}

function getWorkspaceLaunchTarget(): WorkspaceLaunchTarget {
  const workspaceFile = vscode.workspace.workspaceFile
  if (workspaceFile) {
    if (workspaceFile.scheme === 'file') {
      return {
        kind: 'localPaths',
        paths: [workspaceFile.fsPath],
      }
    }

    return {
      kind: 'remotePath',
      authority: workspaceFile.authority,
      path: workspaceFile.path,
    }
  }

  const folders = vscode.workspace.workspaceFolders || []
  if (folders.length === 0) {
    return { kind: 'emptyWindow' }
  }

  const remoteAuthorities = new Set(
    folders
      .map((folder) => asNonEmptyString(folder.uri.authority))
      .filter((value): value is string => Boolean(value)),
  )

  if (remoteAuthorities.size > 1) {
    return {
      kind: 'unsupported',
      reason: vscode.l10n.t(
        'Multi-root workspaces across multiple remote authorities are not supported for isolated relaunch.',
      ),
    }
  }

  if (remoteAuthorities.size === 1) {
    if (folders.length > 1) {
      return {
        kind: 'unsupported',
        reason: vscode.l10n.t(
          'Save this remote multi-root workspace to a .code-workspace file before enabling isolated runtime mode.',
        ),
      }
    }

    return {
      kind: 'remotePath',
      authority: folders[0].uri.authority,
      path: folders[0].uri.path,
    }
  }

  return {
    kind: 'localPaths',
    paths: folders.map((folder) => folder.uri.fsPath),
  }
}

function getWorkspaceLabelAndSource(): { label: string; source: string } {
  const workspaceFile = vscode.workspace.workspaceFile
  if (workspaceFile) {
    const rawLabel =
      workspaceFile.scheme === 'file'
        ? path.basename(
            workspaceFile.fsPath,
            path.extname(workspaceFile.fsPath),
          )
        : path.posix.basename(
            workspaceFile.path,
            path.posix.extname(workspaceFile.path),
          )
    return {
      label: rawLabel || 'workspace',
      source: `workspace:${getUriKey(workspaceFile)}`,
    }
  }

  const folders = [...(vscode.workspace.workspaceFolders || [])]
  if (folders.length === 0) {
    return {
      label: 'empty-window',
      source: 'window:empty',
    }
  }

  const sortedKeys = folders.map((folder) => getUriKey(folder.uri)).sort()
  return {
    label: folders[0].name || 'workspace',
    source: `folders:${sortedKeys.join('|')}`,
  }
}

export function getWorkspaceIsolationDescriptor(): WorkspaceIsolationDescriptor {
  const { label, source } = getWorkspaceLabelAndSource()
  const hash = crypto
    .createHash('sha256')
    .update(source)
    .digest('hex')
    .slice(0, 16)
  const workspaceLabel = sanitizeLabel(label)
  const baseDir = path.join(getIsolationRoot(), `${workspaceLabel}-${hash}`)

  return {
    workspaceKey: hash,
    workspaceLabel,
    baseDir,
    userDataDir: path.join(baseDir, 'user-data'),
    codexHome: path.join(baseDir, 'codex-home'),
    launchTarget: getWorkspaceLaunchTarget(),
  }
}

export function ensureWorkspaceIsolationDirs(
  descriptor: WorkspaceIsolationDescriptor,
): void {
  // These directories are shared across normal and isolated instances, so we
  // create them under the user home instead of VS Code global storage.
  fs.mkdirSync(descriptor.userDataDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(descriptor.codexHome, { recursive: true, mode: 0o700 })
}

export function adoptManagedRuntimeEnvironmentFromContext(
  context: Pick<vscode.ExtensionContext, 'globalStorageUri'>,
): boolean {
  if (getRuntimeIsolationMode() !== 'isolatedInstance') {
    return false
  }

  const descriptor = getWorkspaceIsolationDescriptor()
  if (descriptor.launchTarget.kind === 'unsupported') {
    return false
  }

  const storageUri = context.globalStorageUri
  const storagePath =
    storageUri && (!storageUri.scheme || storageUri.scheme === 'file')
      ? asNonEmptyString(storageUri.fsPath)
      : undefined
  if (!storagePath) {
    return false
  }

  if (!isPathInsideOrEqual(descriptor.userDataDir, storagePath)) {
    return false
  }

  // VS Code desktop launchers can preserve --user-data-dir while dropping the
  // environment passed to the `code` CLI before the extension host starts. In
  // that case the managed user-data directory is the durable signal that this
  // is the isolated instance, so hydrate the env markers before auth paths are
  // resolved from CODEX_HOME.
  process.env.CODEX_HOME = descriptor.codexHome
  process.env[ISOLATED_INSTANCE_KEY_ENV] = descriptor.workspaceKey
  process.env[ISOLATED_INSTANCE_USER_DATA_ENV] = descriptor.userDataDir
  return true
}

export function getRuntimeIsolationStatus(): RuntimeIsolationStatus {
  const mode = getRuntimeIsolationMode()
  const descriptor = getWorkspaceIsolationDescriptor()

  if (mode !== 'isolatedInstance') {
    return {
      mode,
      descriptor,
      isManagedWindow: true,
      requiresRelaunch: false,
      warningMessage: isWorkspaceScopeIgnored()
        ? vscode.l10n.t(
            'codexSwitch.activeProfileScope=workspace is ignored while runtimeIsolationMode is sharedRuntime because all windows share one runtime auth file.',
          )
        : undefined,
    }
  }

  if (descriptor.launchTarget.kind === 'unsupported') {
    return {
      mode,
      descriptor,
      isManagedWindow: false,
      requiresRelaunch: false,
      warningMessage: descriptor.launchTarget.reason,
    }
  }

  const isManagedWindow =
    process.env.CODEX_HOME === descriptor.codexHome &&
    process.env[ISOLATED_INSTANCE_KEY_ENV] === descriptor.workspaceKey &&
    process.env[ISOLATED_INSTANCE_USER_DATA_ENV] === descriptor.userDataDir

  return {
    mode,
    descriptor,
    isManagedWindow,
    requiresRelaunch: !isManagedWindow,
    warningMessage: isManagedWindow
      ? undefined
      : vscode.l10n.t(
          'This workspace is configured for isolated runtime mode, but the current VS Code window was not launched with the managed CODEX_HOME and user-data directory.',
        ),
  }
}

function quoteShellArg(value: string): string {
  if (process.platform === 'win32') {
    return '"' + value.replace(/"/g, '\\"') + '"'
  }

  const singleQuote = String.fromCharCode(39)
  const escapedSingleQuote = `${singleQuote}\\${singleQuote}${singleQuote}`
  return (
    singleQuote +
    value.split(singleQuote).join(escapedSingleQuote) +
    singleQuote
  )
}

function formatEnvPrefix(env: Record<string, string | undefined>): string {
  const vars = [
    ['CODEX_HOME', env.CODEX_HOME],
    [ISOLATED_INSTANCE_KEY_ENV, env[ISOLATED_INSTANCE_KEY_ENV]],
    [ISOLATED_INSTANCE_USER_DATA_ENV, env[ISOLATED_INSTANCE_USER_DATA_ENV]],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]))

  if (vars.length === 0) {
    return ''
  }

  if (process.platform === 'win32') {
    return `${vars
      .map(([key, value]) => `set "${key}=${value}"`)
      .join(' && ')} && `
  }

  return `${vars
    .map(([key, value]) => `${key}=${quoteShellArg(value)}`)
    .join(' ')} `
}

function getCliName(): string {
  return vscode.env.uriScheme === 'vscode-insiders' ? 'code-insiders' : 'code'
}

function resolveCliExecutable(): string {
  const cliName = getCliName()
  const candidates = [
    process.env.VSCODE_CLI,
    path.join(vscode.env.appRoot || '', 'bin', cliName),
    path.join(vscode.env.appRoot || '', '..', 'bin', cliName),
    path.join(vscode.env.appRoot || '', '..', '..', 'bin', cliName),
    cliName,
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    if (candidate === cliName || fs.existsSync(candidate)) {
      return candidate
    }
  }

  return cliName
}

export function buildIsolatedLaunchCommand(
  descriptor: WorkspaceIsolationDescriptor,
): IsolatedLaunchCommand | null {
  if (descriptor.launchTarget.kind === 'unsupported') {
    return null
  }

  const executable = resolveCliExecutable()
  const args = [
    '--new-window',
    '--user-data-dir',
    descriptor.userDataDir,
    '--skip-add-to-recently-opened',
  ]

  if (descriptor.launchTarget.kind === 'localPaths') {
    args.push(...descriptor.launchTarget.paths)
  } else if (descriptor.launchTarget.kind === 'remotePath') {
    args.push(
      '--remote',
      descriptor.launchTarget.authority,
      descriptor.launchTarget.path,
    )
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    CODEX_HOME: descriptor.codexHome,
    [ISOLATED_INSTANCE_KEY_ENV]: descriptor.workspaceKey,
    [ISOLATED_INSTANCE_USER_DATA_ENV]: descriptor.userDataDir,
  }

  const printableCommand = `${formatEnvPrefix(env)}${[executable, ...args]
    .map(quoteShellArg)
    .join(' ')}`
  return {
    executable,
    args,
    env,
    printableCommand,
  }
}
