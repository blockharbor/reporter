import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { clipboard, shell } from 'electron';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Tray } from 'electron';
import type {
  AboutInfo,
  CaptureDraft,
  EngagementLite,
  EvidenceLite,
  SettingsPatch,
  TagLite,
} from '../shared/types.js';
import { CH } from '../shared/channels.js';
import { getCurrentEngagement, getHotkeys, getSettings, saveSettings } from './settings.js';
import { addItem, listQueue, removeItem, updateItem } from './queue.js';
import { makeClient } from './reporter-client.js';
import { drainQueue } from './uploader.js';
import { captureScreenshot, type CaptureMode } from './capture.js';
import { BUILD_INFO } from './build-info.js';
import { checkForUpdates } from './updates.js';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let pendingDraft: CaptureDraft | null = null;
let cachedEngagements: EngagementLite[] = [];

const isDev = Boolean(process.env['ELECTRON_RENDERER_URL']);

// On Linux the Chromium GPU process frequently fails to initialize on the
// headless / VM / RDP boxes common for red-team ops — "Exiting GPU process due
// to errors during initialization" (viz_main_impl.cc) — which can leave the
// capture window blank. reporter is a small tray + form UI that gains nothing
// from GPU acceleration, so disable it on Linux for reliable software rendering.
// Set REPORTER_ENABLE_GPU=1 to opt back in on a machine with a working GPU.
if (process.platform === 'linux' && !process.env['REPORTER_ENABLE_GPU']) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 640,
    show: false,
    resizable: true,
    title: 'reporter',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.on('close', (e) => {
    // Keep running in the tray instead of quitting.
    if (!(app as unknown as { isQuiting?: boolean }).isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'));

  return win;
}

function showView(view: 'history' | 'settings' | 'compose' | 'about'): void {
  if (!mainWindow) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(CH.navigate, view);
}

function notifyQueueChanged(): void {
  mainWindow?.webContents.send(CH.queueChanged);
}

async function drain(): Promise<void> {
  await drainQueue(notifyQueueChanged);
}

// ---------------------------------------------------------------------------
// Capture → compose
// ---------------------------------------------------------------------------

async function captureAndCompose(mode: CaptureMode): Promise<void> {
  // Hide our own window first so it can't occlude the target region (or, for
  // window mode, be the window that gets captured), then give the compositor a
  // moment to drop it before the screenshot tool grabs the screen.
  const wasVisible = mainWindow?.isVisible() ?? false;
  try {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
      await new Promise((r) => setTimeout(r, 250));
    }
    const filePath = await captureScreenshot(mode);
    if (!filePath) {
      // The user cancelled — restore the window they launched capture from.
      if (wasVisible) showView('history');
      return;
    }
    const preview = await readFile(filePath)
      .then((b) => `data:image/png;base64,${b.toString('base64')}`)
      .catch(() => undefined);
    pendingDraft = { contentType: 'image', filePath, previewDataUrl: preview };
    showView('compose');
    mainWindow?.webContents.send(CH.draftReady);
  } catch (err) {
    pendingDraft = null;
    // Never fail silently: log it and surface the reason as a toast. showView
    // also re-reveals the window (hidden above) so the toast is actually seen.
    console.error('[reporter] capture failed:', err);
    showView('history');
    mainWindow?.webContents.send(
      'event:capture-error',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function composeCodeblockFromClipboard(): void {
  const text = clipboard.readText();
  pendingDraft = { contentType: 'codeblock', content: text };
  showView('compose');
  mainWindow?.webContents.send(CH.draftReady);
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function trayIconPath(): string {
  // In a packaged app the icon is shipped via extraResources (resourcesPath);
  // in dev it sits in the source build/ folder.
  return app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(import.meta.dirname, '../../build/tray.png');
}

function buildTray(): void {
  const icon = nativeImage.createFromPath(trayIconPath());
  if (!tray) {
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('reporter');
  }

  const current = getCurrentEngagement();
  const engsSubmenu =
    cachedEngagements.length > 0
      ? cachedEngagements.map((eng) => ({
          label: eng.name,
          type: 'radio' as const,
          checked: eng.slug === current,
          click: () => {
            saveSettings({ currentEngagementSlug: eng.slug });
            buildTray();
          },
        }))
      : [{ label: 'No engagements loaded — open Settings', enabled: false }];

  const menu = Menu.buildFromTemplate([
    { label: 'Capture area', click: () => captureAndCompose('area') },
    { label: 'Capture window', click: () => captureAndCompose('window') },
    { label: 'Add code block from clipboard', click: composeCodeblockFromClipboard },
    { type: 'separator' },
    { label: 'Engagement', submenu: engsSubmenu },
    { type: 'separator' },
    { label: 'History', click: () => showView('history') },
    { label: 'Settings', click: () => showView('settings') },
    { label: `About reporter (v${BUILD_INFO.version})`, click: () => showView('about') },
    { type: 'separator' },
    {
      label: 'Quit reporter',
      click: () => {
        (app as unknown as { isQuiting?: boolean }).isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// Global shortcuts (best-effort; not available under Wayland)
// ---------------------------------------------------------------------------

async function warmEngagements(): Promise<void> {
  const client = makeClient();
  if (!client) return;
  try {
    const engs = await client.listEngagements();
    cachedEngagements = engs.map((o) => ({ slug: o.slug, name: o.name, status: o.status }));
    buildTray();
  } catch {
    // Offline or not yet configured — the tray shows the fallback entry.
  }
}

function registerShortcuts(): void {
  globalShortcut.unregisterAll();
  const { captureArea, captureWindow } = getHotkeys();
  try {
    if (captureArea) globalShortcut.register(captureArea, () => captureAndCompose('area'));
    if (captureWindow) globalShortcut.register(captureWindow, () => captureAndCompose('window'));
  } catch {
    // Ignore registration failures (e.g. Wayland) — tray menu still works.
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(CH.getSettings, () => getSettings());

  ipcMain.handle(CH.saveSettings, (_e, patch: SettingsPatch) => {
    const settings = saveSettings(patch);
    registerShortcuts();
    buildTray();
    return settings;
  });

  ipcMain.handle(CH.testConnection, async () => {
    const client = makeClient();
    if (!client) return { ok: false, error: 'Server URL and API key are required.' };
    try {
      const res = await client.checkConnection();
      return { ok: true, user: res.user.email };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(CH.listEngagements, async (): Promise<EngagementLite[]> => {
    const client = makeClient();
    if (!client) return [];
    const engs = await client.listEngagements();
    cachedEngagements = engs.map((o) => ({ slug: o.slug, name: o.name, status: o.status }));
    buildTray();
    return cachedEngagements;
  });

  ipcMain.handle(CH.listTags, async (_e, slug: string): Promise<TagLite[]> => {
    const client = makeClient();
    if (!client) return [];
    const tags = await client.listTags(slug);
    return tags.map((t) => ({ id: t.id, name: t.name, colorName: t.colorName }));
  });

  ipcMain.handle(
    CH.createTag,
    async (_e, slug: string, input: { name: string; colorName: string }): Promise<TagLite> => {
      const client = makeClient();
      if (!client) throw new Error('Server URL and API key are required.');
      const t = await client.createTag(slug, input);
      return { id: t.id, name: t.name, colorName: t.colorName };
    },
  );

  ipcMain.handle(CH.listEvidence, async (_e, slug: string): Promise<EvidenceLite[]> => {
    const client = makeClient();
    if (!client) return [];
    // Fetch the largest page the server allows (newest first); the picker lists
    // recent top-level evidence. Older items fall off — the web UI / reporter-term
    // (--link-to <uuid>) can still target any evidence by UUID.
    const page = await client.listEvidence(slug, { pageSize: 250 });
    // Only top-level evidence can host linked evidence (linking is one level deep).
    return page.items
      .filter((e) => e.parentEvidenceUuid === null)
      .map((e) => ({
        uuid: e.uuid,
        title: e.title,
        description: e.description,
        contentType: e.contentType,
        occurredAt: e.occurredAt,
        excludeFromReport: e.excludeFromReport,
      }));
  });

  ipcMain.handle(CH.setEngagement, (_e, slug: string | null) => {
    saveSettings({ currentEngagementSlug: slug });
    buildTray();
    return getSettings();
  });

  ipcMain.handle(CH.getQueue, () => listQueue());
  ipcMain.handle(CH.getDraft, () => pendingDraft);

  ipcMain.handle(
    CH.submitDraft,
    async (
      _e,
      payload: {
        engagementSlug: string;
        title: string;
        description: string;
        tagIds: number[];
        contentType: 'image' | 'codeblock' | 'none';
        filePath?: string;
        content?: string;
        contentSubtype?: string;
        parentEvidenceUuid?: string;
      },
    ) => {
      addItem({
        engagementSlug: payload.engagementSlug,
        contentType: payload.contentType,
        filePath: payload.filePath,
        content: payload.content,
        contentSubtype: payload.contentSubtype,
        title: payload.title,
        description: payload.description,
        tagIds: payload.tagIds,
        parentEvidenceUuid: payload.parentEvidenceUuid,
        occurredAt: new Date().toISOString(),
      });
      pendingDraft = null;
      notifyQueueChanged();
      void drain();
      return { ok: true };
    },
  );

  ipcMain.handle(CH.retryItem, (_e, id: string) => {
    updateItem(id, { status: 'pending', error: undefined });
    notifyQueueChanged();
    void drain();
  });

  ipcMain.handle(CH.removeItem, (_e, id: string) => {
    removeItem(id);
    notifyQueueChanged();
  });

  ipcMain.handle(CH.captureArea, () => captureAndCompose('area'));
  ipcMain.handle(CH.captureWindow, () => captureAndCompose('window'));

  ipcMain.handle(CH.getAbout, (): AboutInfo => buildAboutInfo());
  ipcMain.handle(CH.checkForUpdates, () => checkForUpdates());
  ipcMain.handle(CH.openExternal, (_e, url: string) => {
    // Only follow web links — never file:// or arbitrary schemes from the renderer.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function buildAboutInfo(): AboutInfo {
  return {
    productName: 'reporter',
    version: BUILD_INFO.version,
    commit: BUILD_INFO.commit,
    buildDate: BUILD_INFO.buildDate,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    homepage: BUILD_INFO.homepage,
    serverUrl: getSettings().serverUrl,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // Support `reporter-desktop --capture-area` (Wayland keybind workaround).
    if (argv.includes('--capture-area')) captureAndCompose('area');
    else if (argv.includes('--capture-window')) captureAndCompose('window');
    else showView('history');
  });

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.hide(); // tray-only app
    // Keep the OS-native "About" panel in sync with the in-app About view.
    app.setAboutPanelOptions({
      applicationName: 'reporter',
      applicationVersion: BUILD_INFO.version,
      version: BUILD_INFO.commit,
      website: BUILD_INFO.homepage,
    });
    mainWindow = createWindow();
    registerIpc();
    buildTray();
    registerShortcuts();

    // Handle a capture flag on first launch.
    if (process.argv.includes('--capture-area')) captureAndCompose('area');

    // Warm the engagements cache (populates the tray submenu) and drain the queue.
    void warmEngagements();
    void drain();
    setInterval(() => void drain(), 30_000);
    console.log('[reporter] desktop ready — tray active, window hidden');
  });

  app.on('window-all-closed', () => {
    // Stay alive in the tray (except on explicit quit handled above).
  });

  app.on('activate', () => showView('history'));

  app.on('will-quit', () => globalShortcut.unregisterAll());
}

export { isDev };
