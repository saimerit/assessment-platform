import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { is } from '@electron-toolkit/utils'

const execFileAsync = promisify(execFile)
const BLACKLISTED_PROCESSES = [
  'discord.exe',
  'slack.exe',
  'anydesk.exe',
  'teamviewer.exe',
  'zoom.exe',
  'obs64.exe',
  'obs32.exe',
  'vncviewer.exe',
  'vmware.exe',
  'virtualbox.exe'
] as const

export interface MitigationResult {
  killed: string[]
  errors: string[]
}

/** Scans only the explicit denylist and avoids running shell-interpolated commands. */
export async function mitigateUnwantedProcesses(): Promise<MitigationResult> {
  if (is.dev || process.platform !== 'win32') return { killed: [], errors: [] }

  const killed: string[] = []
  const errors: string[] = []
  let running: string
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'])
    running = stdout.toLowerCase()
  } catch (error) {
    return { killed, errors: [`Process inspection failed: ${error instanceof Error ? error.message : String(error)}`] }
  }

  for (const processName of BLACKLISTED_PROCESSES) {
    if (!running.includes(`"${processName}"`)) continue
    try {
      await execFileAsync('taskkill', ['/F', '/IM', processName])
      killed.push(processName)
    } catch (error) {
      errors.push(`Could not terminate ${processName}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { killed, errors }
}
