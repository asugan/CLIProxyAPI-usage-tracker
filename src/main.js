const { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
  baseUrl: 'http://127.0.0.1:8317',
  managementKey: '',
  pollSeconds: 10,
  autoPoll: false,
};

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, '..', 'assets', 'tray-icon.png');

let mainWindow;
let pollTimer;
let tray;
let isQuitting = false;
let database;

const getStoreDir = () => path.join(app.getPath('userData'), 'store');
const getEventsPath = () => path.join(getStoreDir(), 'usage-events.json');
const getDatabasePath = () => path.join(getStoreDir(), 'usage-events.sqlite');
const getSettingsPath = () => path.join(getStoreDir(), 'settings.json');

const ensureStore = async () => {
  await fs.mkdir(getStoreDir(), { recursive: true });
};

const readJson = async (filePath, fallback) => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const writeJson = async (filePath, value) => {
  await ensureStore();
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
};

const normalizeSettings = (settings) => ({
  ...DEFAULT_SETTINGS,
  ...settings,
  baseUrl: String(settings?.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ''),
  managementKey: String(settings?.managementKey || ''),
  pollSeconds: Math.max(3, Number(settings?.pollSeconds || DEFAULT_SETTINGS.pollSeconds)),
  autoPoll: Boolean(settings?.autoPoll),
});

const getSettings = async () => normalizeSettings(await readJson(getSettingsPath(), DEFAULT_SETTINGS));

const saveSettings = async (settings) => {
  const current = await getSettings();
  const normalized = normalizeSettings({
    ...current,
    ...settings,
    managementKey: settings?.managementKey === undefined ? current.managementKey : settings.managementKey,
  });
  await writeJson(getSettingsPath(), normalized);
  restartPollingIfNeeded(normalized);
  return maskSettings(normalized);
};

const maskSettings = (settings) => ({
  ...settings,
  hasManagementKey: Boolean(settings.managementKey),
  managementKey: settings.managementKey ? '********' : '',
});

const getDatabase = () => {
  if (!database) {
    database = new DatabaseSync(getDatabasePath());
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT '',
        auth_index TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT 'unknown',
        model TEXT NOT NULL DEFAULT 'unknown',
        alias TEXT NOT NULL DEFAULT '',
        endpoint TEXT NOT NULL DEFAULT '',
        auth_type TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        request_id TEXT NOT NULL DEFAULT '',
        failed INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);
      CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider);
    `);
  }

  return database;
};

const rowToEvent = (row) => ({
  timestamp: row.timestamp,
  latency_ms: row.latency_ms,
  source: row.source,
  auth_index: row.auth_index,
  provider: row.provider,
  model: row.model,
  alias: row.alias,
  endpoint: row.endpoint,
  auth_type: row.auth_type,
  api_key: row.api_key,
  request_id: row.request_id,
  failed: Boolean(row.failed),
  tokens: {
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    reasoning_tokens: row.reasoning_tokens,
    cached_tokens: row.cached_tokens,
    total_tokens: row.total_tokens,
  },
});

const insertEvents = (events) => {
  const db = getDatabase();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO usage_events (
      event_key,
      timestamp,
      latency_ms,
      source,
      auth_index,
      provider,
      model,
      alias,
      endpoint,
      auth_type,
      api_key,
      request_id,
      failed,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      cached_tokens,
      total_tokens,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const event of events) {
      const result = insert.run(
        eventKey(event),
        event.timestamp,
        event.latency_ms,
        event.source,
        event.auth_index,
        event.provider,
        event.model,
        event.alias,
        event.endpoint,
        event.auth_type,
        event.api_key,
        event.request_id,
        event.failed ? 1 : 0,
        event.tokens.input_tokens,
        event.tokens.output_tokens,
        event.tokens.reasoning_tokens,
        event.tokens.cached_tokens,
        event.tokens.total_tokens,
        JSON.stringify(event),
      );
      inserted += result.changes;
    }

    db.exec(`
      DELETE FROM usage_events
      WHERE id NOT IN (
        SELECT id FROM usage_events ORDER BY timestamp DESC, id DESC LIMIT 50000
      )
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return inserted;
};

const getEvents = async () => {
  const rows = getDatabase().prepare(`
    SELECT * FROM usage_events ORDER BY timestamp ASC, id ASC
  `).all();
  return rows.map(rowToEvent);
};

const saveEvents = async (events) => {
  const db = getDatabase();
  db.exec('DELETE FROM usage_events');
  insertEvents(events.slice(-50000));
};

const getStoredEventCount = () => {
  const row = getDatabase().prepare('SELECT COUNT(*) AS count FROM usage_events').get();
  return Number(row?.count || 0);
};

const migrateJsonEventsToSqlite = async () => {
  if (getStoredEventCount() > 0) {
    return;
  }

  const events = await readJson(getEventsPath(), []);
  if (!Array.isArray(events) || events.length === 0) {
    return;
  }

  insertEvents(events.map(sanitizeEvent));
};

const eventKey = (event) => [
  event.request_id,
  event.timestamp,
  event.provider,
  event.model,
  event.endpoint,
  event.latency_ms,
].filter(Boolean).join('|');

const sanitizeEvent = (record) => {
  const tokens = record?.tokens || {};
  const inputTokens = Number(tokens.input_tokens || tokens.input || record.input_tokens || 0);
  const outputTokens = Number(tokens.output_tokens || tokens.output || record.output_tokens || 0);
  const reasoningTokens = Number(tokens.reasoning_tokens || record.reasoning_tokens || 0);
  const cachedTokens = Number(tokens.cached_tokens || record.cached_tokens || 0);
  const totalTokens = Number(tokens.total_tokens || record.total_tokens || inputTokens + outputTokens + reasoningTokens);

  return {
    timestamp: record.timestamp || new Date().toISOString(),
    latency_ms: Number(record.latency_ms || 0),
    source: record.source || '',
    auth_index: String(record.auth_index || ''),
    provider: record.provider || 'unknown',
    model: record.model || record.alias || 'unknown',
    alias: record.alias || '',
    endpoint: record.endpoint || '',
    auth_type: record.auth_type || '',
    api_key: record.api_key || '',
    request_id: record.request_id || '',
    failed: Boolean(record.failed),
    tokens: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      cached_tokens: cachedTokens,
      total_tokens: totalTokens,
    },
  };
};

const callManagement = async (settings, endpoint) => {
  if (!settings.managementKey) {
    throw new Error('Management key girilmedi.');
  }

  const response = await fetch(`${settings.baseUrl}/v0/management${endpoint}`, {
    headers: {
      Authorization: `Bearer ${settings.managementKey}`,
      'X-Management-Key': settings.managementKey,
    },
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const message = typeof payload === 'object' && payload?.error
      ? payload.message || payload.error
      : response.statusText;
    throw new Error(`${response.status}: ${message}`);
  }

  return payload;
};

const collectUsage = async () => {
  const settings = await getSettings();
  const records = await callManagement(settings, '/usage-queue?count=100');
  const incoming = Array.isArray(records) ? records.map(sanitizeEvent) : [];
  const inserted = insertEvents(incoming);
  mainWindow?.webContents.send('usage-updated');

  return {
    collected: incoming.length,
    inserted,
    stored: getStoredEventCount(),
  };
};

const getApiKeyUsage = async () => {
  const settings = await getSettings();
  return callManagement(settings, '/api-key-usage');
};

const getLogs = async (after = 0) => {
  const settings = await getSettings();
  return callManagement(settings, `/logs?after=${encodeURIComponent(after)}`);
};

const summarizeEvents = (events) => {
  const totals = {
    requests: events.length,
    failed: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    total_tokens: 0,
  };
  const byModel = new Map();
  const byProvider = new Map();
  const byDay = new Map();
  const bySource = new Map();

  const addToMap = (map, key, event) => {
    const current = map.get(key) || {
      key,
      requests: 0,
      failed: 0,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cached_tokens: 0,
    };

    current.requests += 1;
    current.failed += event.failed ? 1 : 0;
    current.total_tokens += event.tokens.total_tokens;
    current.input_tokens += event.tokens.input_tokens;
    current.output_tokens += event.tokens.output_tokens;
    current.reasoning_tokens += event.tokens.reasoning_tokens;
    current.cached_tokens += event.tokens.cached_tokens;
    map.set(key, current);
  };

  for (const event of events) {
    totals.failed += event.failed ? 1 : 0;
    totals.input_tokens += event.tokens.input_tokens;
    totals.output_tokens += event.tokens.output_tokens;
    totals.reasoning_tokens += event.tokens.reasoning_tokens;
    totals.cached_tokens += event.tokens.cached_tokens;
    totals.total_tokens += event.tokens.total_tokens;

    addToMap(byModel, event.model || 'unknown', event);
    addToMap(byProvider, event.provider || 'unknown', event);
    addToMap(byDay, String(event.timestamp || '').slice(0, 10) || 'unknown', event);
    addToMap(bySource, event.source || event.auth_index || 'unknown', event);
  }

  const sorted = (map) => [...map.values()].sort((a, b) => b.total_tokens - a.total_tokens);

  return {
    totals,
    byModel: sorted(byModel),
    byProvider: sorted(byProvider),
    byDay: sorted(byDay),
    bySource: sorted(bySource),
    recent: events.slice(-200).reverse(),
  };
};

const restartPollingIfNeeded = (settings) => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (!settings.autoPoll) {
    return;
  }

  pollTimer = setInterval(() => {
    collectUsage().catch((error) => {
      mainWindow?.webContents.send('collector-error', error.message);
    });
  }, settings.pollSeconds * 1000);
};

const showWindow = () => {
  if (!mainWindow) {
    return;
  }

  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
};

const createTrayIcon = () => {
  return nativeImage.createFromPath(TRAY_ICON_PATH);
};

const createTray = () => {
  if (tray) {
    return;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip('CLIProxyAPI Usage Monitor');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Göster', click: showWindow },
    {
      label: 'Şimdi Topla',
      click: () => collectUsage().catch((error) => {
        mainWindow?.webContents.send('collector-error', error.message);
      }),
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', showWindow);
};

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });

  await mainWindow.loadFile(path.join(__dirname, 'index.html'));
};

app.whenReady().then(async () => {
  ipcMain.handle('settings:get', async () => maskSettings(await getSettings()));
  ipcMain.handle('settings:save', async (_event, settings) => saveSettings(settings));
  ipcMain.handle('usage:collect', async () => collectUsage());
  ipcMain.handle('usage:summary', async () => summarizeEvents(await getEvents()));
  ipcMain.handle('usage:clear', async () => {
    await saveEvents([]);
    mainWindow?.webContents.send('usage-updated');
    return { ok: true };
  });
  ipcMain.handle('usage:api-key', async () => getApiKeyUsage());
  ipcMain.handle('logs:get', async (_event, after) => getLogs(after));

  await ensureStore();
  getDatabase();
  await migrateJsonEventsToSqlite();
  restartPollingIfNeeded(await getSettings());
  await createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
