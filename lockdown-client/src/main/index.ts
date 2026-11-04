import { app, BrowserWindow, globalShortcut, screen, ipcMain, shell, session, systemPreferences, type WebContents } from 'electron'
import { join } from 'path'
import { createServer, type Server as HttpServer } from 'node:http'
import { is } from '@electron-toolkit/utils'
import { reportViolation } from './telemetry'
import { mitigateUnwantedProcesses } from './processMitigation'

let mainWindow: BrowserWindow | null = null
let currentExamToken: string | null = null
let activeExam = { blueprintId: '', studentId: '' }
let isLockdownActive = false
let lockdownShortcutsRegistered = false
let versionProbeServer: HttpServer | null = null

function isTrustedRendererMediaRequest(webContents: WebContents, requestingUrl?: string): boolean {
  if (!mainWindow || webContents.id !== mainWindow.webContents.id || !requestingUrl) return false
  try {
    const appUrl = new URL(mainWindow.webContents.getURL())
    const requestUrl = new URL(requestingUrl)
    if (appUrl.protocol === 'file:') return requestUrl.protocol === 'file:'
    return requestUrl.origin === appUrl.origin && ['localhost', '127.0.0.1'].includes(requestUrl.hostname)
  } catch {
    return false
  }
}

function configureMediaPermissions(): void {
  const appSession = session.defaultSession
  appSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission !== 'media' || !webContents || !details.isMainFrame) return false
    return isTrustedRendererMediaRequest(webContents, details.requestingUrl ?? details.securityOrigin ?? requestingOrigin)
  })

  appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaRequest = 'mediaTypes' in details ? details : null
    const requestingUrl = ('requestingUrl' in details ? details.requestingUrl : undefined) ?? mediaRequest?.securityOrigin
    if (permission !== 'media' || !mediaRequest || !details.isMainFrame || !isTrustedRendererMediaRequest(webContents, requestingUrl)) {
      callback(false)
      return
    }

    const requestedMediaTypes = mediaRequest.mediaTypes?.length ? mediaRequest.mediaTypes : ['video', 'audio']
    if (requestedMediaTypes.some((type) => type !== 'video' && type !== 'audio')) {
      callback(false)
      return
    }

    void (async () => {
      if (process.platform === 'darwin') {
        for (const mediaType of requestedMediaTypes) {
          const permissionType = mediaType === 'video' ? 'camera' : 'microphone'
          const status = systemPreferences.getMediaAccessStatus(permissionType)
          if (status === 'denied' || status === 'restricted') return false
          if (status === 'not-determined' && !(await systemPreferences.askForMediaAccess(permissionType))) return false
        }
      }
      return true
    })().then(callback).catch((error: unknown) => {
      console.error('[Permissions] Failed to authorize camera/microphone access:', error)
      callback(false)
    })
  })
}

function startVersionProbeServer(): void {
  if (versionProbeServer) return

  versionProbeServer = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    response.setHeader('Access-Control-Allow-Private-Network', 'true')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    if (request.method === 'GET' && request.url === '/version') {
      response.writeHead(200)
      response.end(JSON.stringify({ version: app.getVersion(), status: 'READY' }))
      return
    }

    response.writeHead(request.url === '/version' ? 405 : 404)
    response.end(JSON.stringify({ error: 'Not found' }))
  })

  versionProbeServer.on('error', (error) => {
    console.warn(`[System] Could not start desktop version probe: ${error.message}`)
    versionProbeServer = null
  })
  versionProbeServer.listen(48991, '127.0.0.1', () => {
    console.log('[System] Desktop version probe listening on http://127.0.0.1:48991/version')
  })
}

function parseExamToken(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'lockdown:' ? url.searchParams.get('token') : null
  } catch {
    return null
  }
}

function captureDeepLink(args: string[]): void {
  const deepLink = args.find((arg) => arg.startsWith('lockdown://'))
  const token = deepLink ? parseExamToken(deepLink) : null
  if (token) currentExamToken = token
}

if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient('lockdown', process.execPath, [join(process.cwd(), process.argv[1])])
} else {
  app.setAsDefaultProtocolClient('lockdown')
}

captureDeepLink(process.argv)
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else {
  app.on('second-instance', (_event, commandLine) => {
    captureDeepLink(commandLine)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      if (currentExamToken) mainWindow.webContents.send('exam:token-loaded', currentExamToken)
    }
  })
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  captureDeepLink([url])
  if (mainWindow && currentExamToken) mainWindow.webContents.send('exam:token-loaded', currentExamToken)
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    fullscreen: false,
    kiosk: false,
    alwaysOnTop: false,
    resizable: true,
    frame: false,
    skipTaskbar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      devTools: true
    }
  });

  // Maximized window keeps the Windows taskbar available before passcode verification.
  mainWindow.maximize();

  if (is.dev) {
    mainWindow.webContents.openDevTools();
  }

  // Register monitoring up front, but keep every guard inert until the renderer
  // confirms that the passcode was accepted and the assessment has started.
  mainWindow.on('leave-full-screen', () => {
    if (isLockdownActive && !is.dev) {
      mainWindow?.setFullScreen(true);
      if (activeExam.blueprintId && activeExam.studentId) reportViolation({
        blueprintId: activeExam.blueprintId,
        studentId: activeExam.studentId,
        violationType: 'FULLSCREEN_EXIT_ATTEMPT'
      });
    }
  });

  mainWindow.on('blur', () => {
    if (isLockdownActive && !is.dev) {
      console.warn('[Guard] Window focus lost!');
      if (activeExam.blueprintId && activeExam.studentId) reportViolation({
        blueprintId: activeExam.blueprintId,
        studentId: activeExam.studentId,
        violationType: 'WINDOW_FOCUS_LOST',
        evidence: { blur_timestamp: new Date().toISOString() }
      });
    }
  });

  mainWindow.webContents.on('devtools-opened', () => {
    if (isLockdownActive && !is.dev) {
      mainWindow?.webContents.closeDevTools();
      console.warn('[Guard] DevTools access attempt!');
      if (activeExam.blueprintId && activeExam.studentId) reportViolation({
        blueprintId: activeExam.blueprintId,
        studentId: activeExam.studentId,
        violationType: 'DEVTOOLS_ACCESS_ATTEMPT'
      });
    }
  });

  if (!is.dev) {
    screen.on('display-added', (_event, newDisplay) => {
      if (!isLockdownActive) return
      console.warn('[Guard] Secondary display attached!');
      if (activeExam.blueprintId && activeExam.studentId) reportViolation({
        blueprintId: activeExam.blueprintId,
        studentId: activeExam.studentId,
        violationType: 'SECONDARY_DISPLAY_ATTACHED',
        evidence: {
          display_id: newDisplay.id,
          bounds: newDisplay.bounds
        }
      });

      mainWindow?.webContents.send('proctor:security-warning', {
        type: 'MULTIPLE_DISPLAYS',
        message: 'Secondary display detected. Disconnect it immediately.'
      });
    });
  }

  // Load Vite Dev Server in development or index.html in production
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Global hotkey interceptors
function registerLockdownShortcuts(): void {
  if (is.dev) {
    console.log('[Security] Skipping hotkey interception in development mode.');
    return;
  }
  if (lockdownShortcutsRegistered) return
  lockdownShortcutsRegistered = true

  const blockedKeys = [
    'CommandOrControl+R',
    'CommandOrControl+Shift+R',
    'F5',
    'F11',
    'F12',
    'CommandOrControl+Shift+I',
    'Alt+Tab',
    'CommandOrControl+W'
  ];

  blockedKeys.forEach((key) => {
    globalShortcut.register(key, () => {
      console.warn(`[Guard] Blocked restricted hotkey: ${key}`);
      if (activeExam.blueprintId && activeExam.studentId) reportViolation({
        blueprintId: activeExam.blueprintId,
        studentId: activeExam.studentId,
        violationType: 'BLOCKED_SHORTCUT_TRIGGERED',
        evidence: { shortcut: key }
      });
    });
  });
}

// IPC Handlers
ipcMain.handle('check-monitors', () => {
  const displays = screen.getAllDisplays()
  return {
    count: displays.length,
    isSafe: displays.length === 1
  }
})

ipcMain.handle('exam:get-token', () => currentExamToken)

ipcMain.handle('exam:set-context', (_event, context: { blueprintId: string; studentId: string }) => {
  activeExam = context
})

ipcMain.handle('lockdown:engage', () => {
  if (!mainWindow || isLockdownActive) return
  isLockdownActive = true
  mainWindow.setFullScreen(true)
  mainWindow.setKiosk(true)
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  registerLockdownShortcuts()
})

ipcMain.on('app:close', () => {
  if (isLockdownActive) return
  mainWindow?.destroy()
  app.quit()
})

ipcMain.handle('system:open-external', async (_event, target: string) => {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error('Invalid gateway URL')
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '3000') {
    throw new Error('Only the local exam gateway can be opened from the client')
  }
  await shell.openExternal(url.toString())
})

ipcMain.handle('quit-app', () => {
  app.exit(0)
})

app.whenReady().then(async () => {
  configureMediaPermissions()
  startVersionProbeServer()
  const mitigation = await mitigateUnwantedProcesses()
  if (mitigation.killed.length) console.warn(`[Security] Terminated prohibited processes: ${mitigation.killed.join(', ')}`)
  for (const error of mitigation.errors) console.warn(`[Security] ${error}`)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  versionProbeServer?.close()
  versionProbeServer = null
})
