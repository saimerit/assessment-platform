
export interface LockdownAPI {
  apiBaseUrl: string
  portalBaseUrl: string
  checkMonitors: () => Promise<{ count: number; isSafe: boolean }>
  getExamToken: () => Promise<string | null>
  setExamContext: (context: { blueprintId: string; studentId: string }) => Promise<void>
  engageLockdown: () => Promise<void>
  closeApp: () => void
  openExternal: (url: string) => Promise<void>
  quitApp: () => Promise<void>
  onExamToken: (callback: (token: string) => void) => () => void
}

declare global {
  interface Window {
    lockdownAPI: LockdownAPI
  }
}
