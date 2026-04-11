import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as vscode from 'vscode'
import { execFileSync } from 'child_process'
import { AuthData } from '../types'
import { loadAuthDataFromJson } from './auth-parser'
import { errorLog } from '../utils/log'

/**
 * Resolve default Codex home path.
 */
export function getDefaultCodexHomePath(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

/**
 * Resolve default Codex auth file path.
 */
export function getDefaultCodexAuthPath(): string {
  const localPath = path.join(getDefaultCodexHomePath(), 'auth.json')
  if (!shouldUseWslAuthPath()) {
    return localPath
  }

  const wslPath = resolveWslDefaultCodexAuthPath()
  return wslPath || localPath
}

export function shouldUseWslAuthPath(): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  return !!vscode.workspace
    .getConfiguration('chatgpt')
    .get<boolean>('runCodexInWindowsSubsystemForLinux', false)
}

function resolveWslDefaultCodexAuthPath(): string | null {
  try {
    // Convert WSL ~/.codex/auth.json to a Windows path (for example \\wsl$\<distro>\...).
    const out = execFileSync(
      'wsl.exe',
      ['sh', '-lc', 'wslpath -w ~/.codex/auth.json'],
      { encoding: 'utf8', windowsHide: true },
    )
    const p = String(out || '').trim()
    return p || null
  } catch (error) {
    errorLog('Error resolving WSL auth file path:', error)
    return null
  }
}

export async function loadAuthDataFromFile(
  authPath: string,
): Promise<AuthData | null> {
  try {
    if (!fs.existsSync(authPath)) {
      return null
    }

    const authContent = fs.readFileSync(authPath, 'utf8')
    const authJson = JSON.parse(authContent)
    return loadAuthDataFromJson(authJson)
  } catch (error) {
    errorLog('Error reading auth file:', error)
    return null
  }
}
