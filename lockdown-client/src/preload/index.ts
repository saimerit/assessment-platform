import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('lockdownAPI', {
  apiBaseUrl: process.env.ASSESSMENT_API_URL,
  portalBaseUrl: process.env.PUBLIC_PORTAL_URL,
  checkMonitors: () => ipcRenderer.invoke('check-monitors'),
  getExamToken: () => ipcRenderer.invoke('exam:get-token'),
  setExamContext: (context: { blueprintId: string; studentId: string }) => ipcRenderer.invoke('exam:set-context', context),
  setAttemptToken: (token: string) => ipcRenderer.invoke('exam:set-attempt-token', token),
  readRecovery: () => ipcRenderer.invoke('recovery:read'),
  writeRecovery: (value: string) => ipcRenderer.invoke('recovery:write', value),
  clearRecovery: () => ipcRenderer.invoke('recovery:clear'),
  releaseAfterSubmission: (receiptId: string) => ipcRenderer.invoke('lockdown:release-after-submission', receiptId),
  engageLockdown: () => ipcRenderer.invoke('lockdown:engage'),
  closeApp: () => ipcRenderer.send('app:close'),
  openExternal: (url: string) => ipcRenderer.invoke('system:open-external', url),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  onExamToken: (callback: (token: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, token: string) => callback(token)
    ipcRenderer.on('exam:token-loaded', listener)
    return () => ipcRenderer.removeListener('exam:token-loaded', listener)
  }
})
