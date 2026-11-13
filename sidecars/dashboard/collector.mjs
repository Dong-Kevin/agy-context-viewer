/**
 * Read-only Data Collector for Antigravity Context & Token Viewer Sidecar.
 *
 * Sanctioned data sources only:
 * 1. Official Sidecar environment variables (ANTIGRAVITY_EXECUTABLE_DATA_DIR,
 *    ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN, ANTIGRAVITY_AGENTAPI_EXE).
 * 2. Local on-disk transcripts (<appData>/brain/<conv>/.system_generated/logs/transcript.jsonl
 *    and ~/.gemini/antigravity-cli/brain/).
 * 3. Sidecar's own runtime data directory for user settings persistence.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import {
  addMeasure,
  calcImageTokens,
  calculateReferenceCost,
  calculateRequestApiCost,
  classifyRequestError,
  CURRENCY_SYMBOLS,
  emptyMeasure,
  formatModelDisplayName,
  getImageDimensions,
  groupModelQuotas,
  measureText,
  normalizeModelId,
  parseUserPlanStatus,
  PRICING_VERIFIED_DATE,
  resolveEffectivePlanStatus,
  resolveModelQuota,
  SUBSCRIPTION_ACQUISITION_PRESETS,
  SUBSCRIPTION_REGIONS_PRESET,
  summarizeApiCost
} from './pricing.mjs';

const CONV_ID_RE = /^[0-9a-f-]{8,64}$/i;
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const SKIP_SCAN_DIRS = new Set(['steps', 'scratch', 'media', 'artifacts', 'node_modules', '.git', '__pycache__']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php', '.sh', '.zsh', '.bash', '.sql',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.csv', '.tsv', '.log', '.vue', '.svelte'
]);

// Caches
const fileAuditCache = new Map();       // "realPath|size|mtimeMs" -> attachment result
const transcriptHistCache = new Map();  // filePath -> { size, mtimeMs, records, firstDate, stepCount }
const convGenMetaCache = new Map();     // convId -> { at, callsByStep, latestMeta }
const recentConvMetaCache = new Map();  // logPath -> { key, title, lastContextTokens, turnsCount }
let cachedHostStatus = {
  at: 0,
  lsKey: '',
  sig: 'init',
  raw: null,
  plan: null,
  quotas: [],
  modelConfigs: [],
  quotaSummaryGroups: [],
  dynamicModelMap: {},
  quotaStatus: {
    state: 'unavailable',
    stale: false,
    summaryStale: false,
    source: 'none',
    lastSuccessAt: null,
    summaryLastSuccessAt: null,
    reason: ''
  }
};
let lastGoodHostData = null;
let cachedHistoryResult = { at: 0, hostSig: '', etag: '', data: null };

export const LOOPBACK_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

export function createLoopbackSessionToken() {
  return randomBytes(24).toString('hex');
}

export function injectCsrfMeta(html, token) {
  if (!token || typeof html !== 'string') return html;
  const tag = `  <meta name="cv-csrf-token" content="${token}">\n`;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${tag}</head>`);
  }
  return `${tag}${html}`;
}

function sendLoopbackJsonError(res, status, message, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...LOOPBACK_SECURITY_HEADERS,
    ...extraHeaders
  });
  res.end(JSON.stringify({ ok: false, error: message }));
}

export function guardLoopbackRequest(req, res, { port, token }) {
  const actualPort = Number(port || 0);
  const allowedHosts = new Set([
    `127.0.0.1:${actualPort}`,
    `localhost:${actualPort}`,
    `[::1]:${actualPort}`
  ]);
  const rawHost = String(req.headers?.host || '').trim().toLowerCase();
  if (!actualPort || !rawHost || !allowedHosts.has(rawHost)) {
    sendLoopbackJsonError(res, 403, 'Forbidden host');
    return { ok: false };
  }

  const rawUrl = req.url;
  if (
    typeof rawUrl !== 'string' ||
    !rawUrl.startsWith('/') ||
    rawUrl.startsWith('//') ||
    rawUrl.startsWith('/\\') ||
    rawUrl.includes('\\')
  ) {
    sendLoopbackJsonError(res, 400, 'Invalid request URL');
    return { ok: false };
  }

  const expectedOriginBase = `http://127.0.0.1:${actualPort}`;
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl, expectedOriginBase);
  } catch {
    sendLoopbackJsonError(res, 400, 'Invalid request URL');
    return { ok: false };
  }
  if (parsedUrl.origin !== expectedOriginBase) {
    sendLoopbackJsonError(res, 400, 'Invalid request URL');
    return { ok: false };
  }

  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    sendLoopbackJsonError(res, 405, 'Method not allowed', { Allow: 'GET, POST' });
    return { ok: false };
  }

  const allowedOrigins = new Set([
    `http://127.0.0.1:${actualPort}`,
    `http://localhost:${actualPort}`,
    `http://[::1]:${actualPort}`
  ]);
  const rawOrigin = req.headers?.origin !== undefined ? String(req.headers.origin).trim().toLowerCase() : '';
  const secFetchSite = req.headers?.['sec-fetch-site'] ? String(req.headers['sec-fetch-site']).trim().toLowerCase() : '';

  const isSensitiveGet = parsedUrl.pathname === '/preload.js' || parsedUrl.pathname.startsWith('/api/');
  if (method === 'POST' || isSensitiveGet) {
    if (rawOrigin && !allowedOrigins.has(rawOrigin)) {
      sendLoopbackJsonError(res, 403, 'Forbidden origin');
      return { ok: false };
    }
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      sendLoopbackJsonError(res, 403, 'Cross-site request blocked');
      return { ok: false };
    }
  }

  if (method === 'POST') {
    const contentType = String(req.headers?.['content-type'] || '').trim();
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      sendLoopbackJsonError(res, 415, 'Content-Type must be application/json');
      return { ok: false };
    }
    const providedToken = String(req.headers?.['x-cv-token'] || '');
    const expectedBuf = Buffer.from(String(token || ''), 'utf-8');
    const providedBuf = Buffer.from(providedToken, 'utf-8');
    if (!expectedBuf.length || providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      sendLoopbackJsonError(res, 403, 'Invalid or missing session token');
      return { ok: false };
    }
  }

  return { ok: true, url: parsedUrl, method };
}

export function readLoopbackJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.status = status;
      rejectPromise(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (total > maxBytes) {
        req.resume();
        fail(413, 'Request payload too large');
        return;
      }
      chunks.push(buf);
    });
    req.on('error', () => fail(400, 'Failed to read request body'));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (total === 0) {
        resolvePromise({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolvePromise({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('JSON body must be an object');
          err.status = 400;
          rejectPromise(err);
          return;
        }
        resolvePromise(parsed);
      } catch {
        const err = new Error('Malformed JSON body');
        err.status = 400;
        rejectPromise(err);
      }
    });
  });
}

function computeContentEtag(prefix, payload) {
  return `${prefix}:${createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}`;
}

export function findAppDataDir() {
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const candidate = dirname(d);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return process.env.AG_DIR || join(homedir(), '.gemini', 'antigravity');
}

export function findCliDataDir() {
  return process.env.AG_CLI_DIR || join(homedir(), '.gemini', 'antigravity-cli');
}

export function getPluginStateDir() {
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  return join(findAppDataDir(), 'sidecar_data', 'context-viewer', 'dashboard', 'data');
}

function getSettingsPath() {
  return join(getPluginStateDir(), 'settings_v1.json');
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    const bak = `${filePath}.bak`;
    try {
      if (existsSync(bak)) return JSON.parse(readFileSync(bak, 'utf-8'));
    } catch {}
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const serialized = JSON.stringify(data, null, 2);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, serialized, 'utf-8');
  if (existsSync(filePath)) {
    try {
      writeFileSync(`${filePath}.bak`, readFileSync(filePath));
    } catch {}
  }
  renameSync(tmp, filePath);
}

export function formatLocalDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDurationSec(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const m = String(value).trim().match(/^([\d.]+)\s*s?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function hashAccountKey(email) {
  if (!email || typeof email !== 'string') return 'default';
  return 'acct_' + createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Official Language Server Connect RPC (uses env vars injected by Sidecar SDK)
// ---------------------------------------------------------------------------

function callLanguageServer(method, payload = {}, timeoutMs = 4500) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return Promise.resolve(null);

  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (val) => {
      if (!settled) {
        settled = true;
        resolvePromise(val);
      }
    };

    try {
      const targetUrl = new URL(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`);
      const bodyStr = JSON.stringify(payload);
      const req = http.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port,
          path: targetUrl.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-codeium-csrf-token': csrf,
            'Content-Length': Buffer.byteLength(bodyStr)
          }
        },
        (res) => {
          const chunks = [];
          let total = 0;
          res.on('data', (chunk) => {
            total += chunk.length;
            if (total > 32 * 1024 * 1024) {
              req.destroy();
              finish(null);
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              finish(null);
              return;
            }
            try {
              finish(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch {
              finish(null);
            }
          });
        }
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        finish(null);
      });
      req.on('error', () => finish(null));
      req.end(bodyStr);
    } catch {
      finish(null);
    }
  });
}

function makeQuotaStatus(state, opts = {}) {
  return {
    state,
    stale: Boolean(opts.stale),
    summaryStale: Boolean(opts.summaryStale),
    source: opts.source || 'none',
    lastSuccessAt: opts.lastSuccessAt || null,
    summaryLastSuccessAt: opts.summaryLastSuccessAt || null,
    reason: opts.reason || ''
  };
}

function toStableQuotaState(quotaStatus = {}) {
  return {
    state: quotaStatus.state || 'unavailable',
    stale: Boolean(quotaStatus.stale),
    summaryStale: Boolean(quotaStatus.summaryStale),
    source: quotaStatus.source || 'none'
  };
}

async function getHostUserStatus(force = false) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) {
    return {
      at: Date.now(),
      lsKey: '',
      sig: 'no-ls',
      raw: null,
      plan: parseUserPlanStatus(null),
      quotas: [],
      modelConfigs: [],
      quotaSummaryGroups: [],
      dynamicModelMap: {},
      quotaStatus: makeQuotaStatus('unavailable', {
        source: 'none',
        reason: '未连接宿主语言服务'
      })
    };
  }
  const lsKey = `${lsAddr}|${csrf}`;
  if (!force && cachedHostStatus.at && cachedHostStatus.lsKey === lsKey && Date.now() - cachedHostStatus.at < 30_000) {
    return cachedHostStatus;
  }
  const [res, quotaSummaryRes] = await Promise.all([
    callLanguageServer('GetUserStatus', {}),
    callLanguageServer('RetrieveUserQuotaSummary', {})
  ]);
  const cachedGood = lastGoodHostData?.lsKey === lsKey ? lastGoodHostData : null;
  if (!res) {
    if (cachedGood) {
      const quotaStatus = makeQuotaStatus('stale', {
        stale: true,
        summaryStale: true,
        source: 'cache',
        lastSuccessAt: cachedGood.fetchedAt,
        summaryLastSuccessAt: cachedGood.summaryFetchedAt,
        reason: '语言服务连接失败，当前展示上次成功同步数据'
      });
      const { updatedAt: _planUpdatedAt, ...stablePlan } = cachedGood.plan || {};
      const sig = computeContentEtag('host', {
        plan: stablePlan,
        quotas: cachedGood.quotas,
        dynamicModelMap: cachedGood.dynamicModelMap,
        quotaState: toStableQuotaState(quotaStatus)
      });
      cachedHostStatus = {
        at: Date.now(),
        lsKey,
        sig,
        raw: null,
        plan: cachedGood.plan,
        quotas: cachedGood.quotas,
        modelConfigs: cachedGood.modelConfigs,
        quotaSummaryGroups: cachedGood.quotaSummaryGroups,
        dynamicModelMap: cachedGood.dynamicModelMap,
        quotaStatus
      };
      return cachedHostStatus;
    }
    const plan = parseUserPlanStatus(null);
    const quotaStatus = makeQuotaStatus('error', {
      stale: false,
      summaryStale: false,
      source: 'none',
      lastSuccessAt: null,
      summaryLastSuccessAt: null,
      reason: '语言服务请求失败，暂未获取到配额数据'
    });
    const sig = computeContentEtag('host', { quotaState: toStableQuotaState(quotaStatus) });
    cachedHostStatus = {
      at: Date.now(),
      lsKey,
      sig,
      raw: null,
      plan,
      quotas: [],
      modelConfigs: [],
      quotaSummaryGroups: [],
      dynamicModelMap: {},
      quotaStatus
    };
    return cachedHostStatus;
  }

  const nowIso = new Date().toISOString();
  const plan = parseUserPlanStatus(res);
  const accountHash = hashAccountKey(res?.userStatus?.email || '');
  plan.accountKey = accountHash;
  const modelConfigs = res?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
  const summaryOk = quotaSummaryRes !== null && typeof quotaSummaryRes === 'object';
  const quotaSummaryGroups = summaryOk ? (quotaSummaryRes?.response?.groups || quotaSummaryRes?.groups || []) : [];
  const dynamicModelMap = {};
  for (const cfg of modelConfigs) {
    const mid = String(cfg.modelOrAlias?.model || cfg.modelId || '').trim().toLowerCase();
    const norm = normalizeModelId(cfg.label || '') || normalizeModelId(mid);
    if (mid && norm) dynamicModelMap[mid] = norm;
  }
  const quotas = groupModelQuotas(modelConfigs, quotaSummaryGroups);
  const summaryFetchedAt = summaryOk ? nowIso : (cachedGood?.summaryFetchedAt || null);
  const quotaStatus = summaryOk
    ? makeQuotaStatus('live', {
        stale: false,
        summaryStale: false,
        source: 'live',
        lastSuccessAt: nowIso,
        summaryLastSuccessAt: nowIso,
        reason: ''
      })
    : makeQuotaStatus('degraded', {
        stale: false,
        summaryStale: true,
        source: 'live',
        lastSuccessAt: nowIso,
        summaryLastSuccessAt: summaryFetchedAt,
        reason: '多窗口配额摘要暂不可用，当前仅展示基础配额信息'
      });
  lastGoodHostData = {
    lsKey,
    fetchedAt: nowIso,
    summaryFetchedAt,
    accountKey: accountHash,
    plan,
    quotas,
    modelConfigs,
    quotaSummaryGroups,
    dynamicModelMap
  };
  const { updatedAt: _planUpdatedAt, ...stablePlan } = plan;
  const sig = computeContentEtag('host', {
    plan: stablePlan,
    quotas,
    dynamicModelMap,
    quotaState: toStableQuotaState(quotaStatus)
  });
  cachedHostStatus = {
    at: Date.now(),
    lsKey,
    sig,
    raw: null,
    plan,
    quotas,
    modelConfigs,
    quotaSummaryGroups,
    dynamicModelMap,
    quotaStatus
  };
  return cachedHostStatus;
}

// ---------------------------------------------------------------------------
// Settings Persistence
// ---------------------------------------------------------------------------

function loadRawSettings() {
  const data = readJsonSafe(getSettingsPath(), null);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return {
      version: '1.0.0',
      lastAccountKey: data.lastAccountKey || 'default',
      accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
      uiPreferences: data.uiPreferences && typeof data.uiPreferences === 'object' ? data.uiPreferences : {}
    };
  }
  // Read-only fallback migration from legacy custom_plan_v1.json if present
  const legacy = readJsonSafe(join(findAppDataDir(), 'custom_plan_v1.json'), null);
  if (legacy && typeof legacy === 'object') {
    return {
      version: '1.0.0',
      lastAccountKey: 'default',
      accounts: legacy.accounts?.default ? { default: legacy.accounts.default } : {},
      uiPreferences: legacy.uiPreferences || {}
    };
  }
  return { version: '1.0.0', lastAccountKey: 'default', accounts: {}, uiPreferences: {} };
}

export async function getSettings() {
  const host = await getHostUserStatus(false);
  const settings = loadRawSettings();
  const acctKey = host.plan?.accountKey || settings.lastAccountKey || 'default';
  const customPlan = settings.accounts[acctKey] || settings.accounts.default || null;
  const effectivePlan = resolveEffectivePlanStatus(host.plan, customPlan);
  return {
    ok: true,
    planStatus: effectivePlan,
    customPlan,
    uiPreferences: settings.uiPreferences || {},
    entrypoints: getSidebarEntryStatus(),
    presets: {
      regions: SUBSCRIPTION_REGIONS_PRESET,
      acquisitions: SUBSCRIPTION_ACQUISITION_PRESETS,
      currencies: Object.entries(CURRENCY_SYMBOLS).map(([code, symbol]) => ({ code, symbol }))
    }
  };
}

function getSidecarManifestPath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'sidecar.json');
}

export const MENUBAR_MODES = ['context', 'speed', 'quota'];

export function getMenubarPreference() {
  const settings = loadRawSettings();
  if (typeof settings.uiPreferences?.menubarEnabled === 'boolean') {
    return settings.uiPreferences.menubarEnabled;
  }
  return process.platform === 'darwin';
}

export function setMenubarPreference(enabled) {
  const wantEnabled = Boolean(enabled);
  const settings = loadRawSettings();
  settings.uiPreferences = {
    ...settings.uiPreferences,
    menubarEnabled: wantEnabled,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(getSettingsPath(), settings);
  return wantEnabled;
}

export function getMenubarMode() {
  const settings = loadRawSettings();
  const raw = String(settings.uiPreferences?.menubarMode || 'context').toLowerCase();
  return MENUBAR_MODES.includes(raw) ? raw : 'context';
}

export function setMenubarMode(mode) {
  const norm = String(mode || 'context').toLowerCase();
  const validMode = MENUBAR_MODES.includes(norm) ? norm : 'context';
  const settings = loadRawSettings();
  settings.uiPreferences = {
    ...settings.uiPreferences,
    menubarMode: validMode,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(getSettingsPath(), settings);
  return validMode;
}

function getActiveSessionHintPath() {
  return join(getPluginStateDir(), 'active_session_hint.json');
}

export function readActiveSessionHint() {
  const data = readJsonSafe(getActiveSessionHintPath(), null);
  if (!data || typeof data !== 'object') {
    return {
      pinnedConvId: '',
      userFocusedConvId: '',
      userFocusedAt: 0,
      resolvedConvId: '',
      lastBatchViewMs: 0
    };
  }
  return {
    pinnedConvId: CONV_ID_RE.test(data.pinnedConvId || '') ? data.pinnedConvId : '',
    userFocusedConvId: CONV_ID_RE.test(data.userFocusedConvId || '') ? data.userFocusedConvId : '',
    userFocusedAt: Number(data.userFocusedAt || 0),
    resolvedConvId: CONV_ID_RE.test(data.resolvedConvId || '') ? data.resolvedConvId : '',
    lastBatchViewMs: Number(data.lastBatchViewMs || 0)
  };
}

export function updateActiveSessionHint(patch = {}) {
  const cur = readActiveSessionHint();
  const next = { ...cur };
  if (typeof patch.pinnedConvId === 'string') {
    next.pinnedConvId = CONV_ID_RE.test(patch.pinnedConvId) ? patch.pinnedConvId : '';
  }
  if (typeof patch.userFocusedConvId === 'string' && CONV_ID_RE.test(patch.userFocusedConvId)) {
    next.userFocusedConvId = patch.userFocusedConvId;
    next.userFocusedAt = Number(patch.userFocusedAt || Date.now());
  }
  if (typeof patch.resolvedConvId === 'string') {
    next.resolvedConvId = CONV_ID_RE.test(patch.resolvedConvId) ? patch.resolvedConvId : '';
  }
  if (typeof patch.lastBatchViewMs === 'number') {
    next.lastBatchViewMs = patch.lastBatchViewMs;
  }
  writeJsonAtomic(getActiveSessionHintPath(), next);
  return next;
}

export function getSidebarEntryStatus() {
  const manifestPath = getSidecarManifestPath();
  const manifest = readJsonSafe(manifestPath, null);
  const views = Array.isArray(manifest?.ui_config?.views) ? manifest.ui_config.views : [];
  const sidebarEnabled = views.some((v) => v?.entrypoint === 'SIDECAR_UI_ENTRYPOINT_SIDEBAR');
  const hint = readActiveSessionHint();
  return {
    ok: true,
    menubarEnabled: getMenubarPreference(),
    menubarMode: getMenubarMode(),
    menubarSupported: process.platform === 'darwin',
    pinnedConvId: hint.pinnedConvId || '',
    sidebarEnabled,
    viewsCount: views.length
  };
}

export function setSidebarEntrypoint(enabled, { persist = true } = {}) {
  const wantEnabled = Boolean(enabled);
  const manifestPath = getSidecarManifestPath();
  const manifest = readJsonSafe(manifestPath, null);
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: '未找到 sidecar.json 配置文件' };
  }

  const existingViews = Array.isArray(manifest.ui_config?.views) ? manifest.ui_config.views : [];
  const auxView = existingViews.find((v) => v?.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE') || {
    path: '/',
    entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
    title: '上下文看板'
  };
  const otherViews = existingViews.filter(
    (v) => v?.entrypoint !== 'SIDECAR_UI_ENTRYPOINT_AUX_PANE' && v?.entrypoint !== 'SIDECAR_UI_ENTRYPOINT_SIDEBAR'
  );
  const nextViews = [auxView, ...otherViews];
  if (wantEnabled) {
    nextViews.push({
      path: '/sidebar',
      entrypoint: 'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
      title: '上下文看板'
    });
  }

  const currentlyEnabled = existingViews.some((v) => v?.entrypoint === 'SIDECAR_UI_ENTRYPOINT_SIDEBAR');
  if (currentlyEnabled !== wantEnabled || existingViews.length !== nextViews.length) {
    manifest.ui_config = {
      ...(manifest.ui_config || { display_name: '上下文与 Token 看板' }),
      views: nextViews
    };
    const tmp = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    renameSync(tmp, manifestPath);
  }

  if (persist) {
    const settings = loadRawSettings();
    settings.uiPreferences = {
      ...settings.uiPreferences,
      sidebarEntryEnabled: wantEnabled,
      updatedAt: new Date().toISOString()
    };
    writeJsonAtomic(getSettingsPath(), settings);
  }

  return {
    ok: true,
    sidebarEnabled: wantEnabled,
    message: wantEnabled
      ? '已开启方案 A：左侧栏 Plugins 区「上下文看板」常驻一级入口已激活'
      : '已关闭方案 A：已从左侧栏移除常驻入口（仍可用 📌 右侧置顶小窗或右侧栏）'
  };
}

export function syncSidebarManifestFromSettings() {
  const settings = loadRawSettings();
  if (typeof settings.uiPreferences?.sidebarEntryEnabled === 'boolean') {
    return setSidebarEntrypoint(settings.uiPreferences.sidebarEntryEnabled, { persist: false });
  }
  return getSidebarEntryStatus();
}

export async function saveSettings(payload = {}) {
  const host = await getHostUserStatus(false);
  const settings = loadRawSettings();
  const acctKey = host.plan?.accountKey || settings.lastAccountKey || 'default';

  if (payload.clearPlan === true) {
    delete settings.accounts[acctKey];
    delete settings.accounts.default;
  } else if (payload.customPlan && typeof payload.customPlan === 'object') {
    const prev = settings.accounts[acctKey] || settings.accounts.default || {};
    const next = { ...prev, ...payload.customPlan, updatedAt: new Date().toISOString() };
    settings.accounts[acctKey] = next;
    settings.accounts.default = next;
    settings.lastAccountKey = acctKey;
  }

  if (payload.uiPreferences && typeof payload.uiPreferences === 'object') {
    settings.uiPreferences = {
      ...settings.uiPreferences,
      ...payload.uiPreferences,
      updatedAt: new Date().toISOString()
    };
  }

  writeJsonAtomic(getSettingsPath(), settings);
  cachedHistoryResult.at = 0; // Invalidate history cache so updated plan reflects immediately
  return getSettings();
}

// ---------------------------------------------------------------------------
// Attachment Read-only Scanner (Images, Text/Code, PDF text streams, Office XML)
// ---------------------------------------------------------------------------

function extractOfficeXmlChars(buf) {
  // Minimal read-only ZIP central directory parser for .docx / .xlsx / .pptx XML entries
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const totalEntries = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    let ptr = cdOffset;
    let extractedText = '';
    for (let idx = 0; idx < totalEntries && ptr + 46 <= buf.length; idx++) {
      if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
      const method = buf.readUInt16LE(ptr + 10);
      const compSize = buf.readUInt32LE(ptr + 20);
      const uncompSize = buf.readUInt32LE(ptr + 24);
      const nameLen = buf.readUInt16LE(ptr + 28);
      const extraLen = buf.readUInt16LE(ptr + 30);
      const commentLen = buf.readUInt16LE(ptr + 32);
      const localHeaderOffset = buf.readUInt32LE(ptr + 42);
      const entryName = buf.toString('utf-8', ptr + 46, ptr + 46 + nameLen);
      ptr += 46 + nameLen + extraLen + commentLen;

      if (!/\.(xml|rels|txt|csv|md)$/i.test(entryName)) continue;
      if (!/(word\/document|xl\/sharedStrings|xl\/worksheets\/sheet|ppt\/slides\/slide)/i.test(entryName)) continue;
      if (uncompSize > 8 * 1024 * 1024 || localHeaderOffset + 30 > buf.length) continue;

      const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > buf.length) continue;
      const slice = buf.subarray(dataStart, dataStart + compSize);
      let xml = '';
      if (method === 0) xml = slice.toString('utf-8');
      else if (method === 8) xml = inflateRawSync(slice).toString('utf-8');
      if (xml) {
        extractedText += ' ' + xml.replace(/<[^>]+>/g, ' ');
      }
    }
    return extractedText.trim() || null;
  } catch {
    return null;
  }
}

function inspectAttachmentItem(item) {
  const baseName = item.name || (item.uri ? item.uri.split(/[\\/]/).pop() : '附件');
  const refs = item.references || 1;
  try {
    if (item.inlineData) {
      const buf = Buffer.from(item.inlineData, 'base64');
      const mime = String(item.mime || '').toLowerCase();
      if (mime.startsWith('image/')) {
        const dims = getImageDimensions(buf);
        const [low, high] = calcImageTokens(dims.width, dims.height);
        return {
          name: baseName,
          mime,
          source: item.source || 'user',
          references: refs,
          status: 'parsed',
          bytes: buf.length,
          chars: 0,
          dimensions: dims.width ? `${dims.width}×${dims.height}` : null,
          low,
          high,
          note: dims.width ? `${dims.width}×${dims.height} 像素` : '内嵌图像'
        };
      }
      const text = buf.toString('utf-8');
      const m = measureText(text);
      return {
        name: baseName,
        mime,
        source: item.source || 'user',
        references: refs,
        status: 'parsed',
        ...m,
        dimensions: null,
        note: `${m.chars.toLocaleString()} 字符`
      };
    }

    if (!item.uri || /^https?:/i.test(item.uri)) {
      return { name: baseName, mime: item.mime || '', source: item.source || 'user', references: refs, status: 'unknown', ...emptyMeasure(), note: '远程或无本地路径，未计入零值' };
    }
    const rawPath = item.uri.startsWith('file://') ? fileURLToPath(item.uri) : item.uri;
    if (!existsSync(rawPath)) {
      return { name: baseName, mime: item.mime || '', source: item.source || 'user', references: refs, status: 'unknown', ...emptyMeasure(), note: '本地文件已移除或不可访问' };
    }
    const real = realpathSync(rawPath);
    const st = statSync(real);
    if (!st.isFile()) {
      return { name: baseName, mime: item.mime || '', source: item.source || 'user', references: refs, status: 'unknown', ...emptyMeasure(), note: '非常规文件' };
    }
    if (st.size > MAX_ATTACHMENT_BYTES) {
      return { name: baseName, mime: item.mime || '', source: item.source || 'user', references: refs, status: 'unknown', ...emptyMeasure(), bytes: st.size, note: '文件超过 24 MB 安全扫描上限' };
    }

    const cacheKey = `${real}|${st.size}|${st.mtimeMs}`;
    if (fileAuditCache.has(cacheKey)) {
      return { ...fileAuditCache.get(cacheKey), name: baseName, references: refs, source: item.source || 'user' };
    }

    const ext = extname(real).toLowerCase();
    const mime = String(item.mime || '').toLowerCase();
    const buf = readFileSync(real);
    let parsed = null;

    if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
      const dims = getImageDimensions(buf);
      const [low, high] = calcImageTokens(dims.width, dims.height);
      parsed = {
        mime: mime || `image/${ext.slice(1)}`,
        status: 'parsed',
        bytes: st.size,
        chars: 0,
        dimensions: dims.width ? `${dims.width}×${dims.height}` : null,
        low,
        high,
        note: dims.width ? `${dims.width}×${dims.height} 像素` : '图像文件'
      };
    } else if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext) || ext === '.svg') {
      const text = buf.toString('utf-8');
      const m = measureText(text);
      parsed = {
        mime: mime || 'text/plain',
        status: 'parsed',
        ...m,
        dimensions: null,
        note: `${m.chars.toLocaleString()} 字符`
      };
    } else if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
      const xmlText = extractOfficeXmlChars(buf);
      if (xmlText) {
        const m = measureText(xmlText);
        parsed = {
          mime: mime || 'application/octet-stream',
          status: 'parsed',
          bytes: st.size,
          chars: m.chars,
          low: m.low,
          high: m.high,
          dimensions: null,
          note: `Office 文档文本约 ${m.chars.toLocaleString()} 字符`
        };
      }
    }

    if (!parsed) {
      parsed = {
        mime: mime || 'application/octet-stream',
        status: 'unknown',
        ...emptyMeasure(),
        bytes: st.size,
        dimensions: null,
        note: ext === '.pdf' ? 'PDF 多模态页内容未按零处理，以服务端实际统计为准' : '二进制或多媒体格式，未按零处理'
      };
    }

    if (fileAuditCache.size > 500) {
      const oldest = fileAuditCache.keys().next().value;
      if (oldest) fileAuditCache.delete(oldest);
    }
    fileAuditCache.set(cacheKey, parsed);
    return { ...parsed, name: baseName, references: refs, source: item.source || 'user' };
  } catch (err) {
    return {
      name: baseName,
      mime: item.mime || '',
      source: item.source || 'user',
      references: refs,
      status: 'unknown',
      ...emptyMeasure(),
      note: `读取受阻：${err.message || '未知原因'}`
    };
  }
}

// ---------------------------------------------------------------------------
// Recent Conversations Discovery
// ---------------------------------------------------------------------------

function extractCleanUserTitle(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  const reqMatch = rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  const text = (reqMatch ? reqMatch[1] : rawContent)
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 44 ? `${text.slice(0, 44)}…` : text;
}

export function parseModelSettingFromText(text) {
  if (!text || typeof text !== 'string' || !/Model Selection/i.test(text)) return null;
  const re = /Model Selection[`"']?\s+from\s+[^\r\n]+?\s+to\s+([^\r\n<]+?)(?:\.(?=\s|$|<)|[;，。]|\r?\n|<|$)/gi;
  let lastPicked = null;
  for (const m of text.matchAll(re)) {
    const cleaned = m[1].trim().replace(/^[`"']+|[`"']+$/g, '').trim();
    if (!cleaned) continue;
    lastPicked = cleaned.toLowerCase() === 'none' ? null : cleaned;
  }
  return lastPicked;
}

function extractStepModel(step, gmEntry = null, fallbackRunningModel = '') {
  const gmModel = gmEntry?.chatModel?.modelDisplayName
    || gmEntry?.chatModel?.responseModel
    || gmEntry?.chatModel?.model
    || '';
  const stepModel = step?.chatModel?.modelDisplayName
    || step?.chatModel?.responseModel
    || step?.chatModel?.model
    || step?.modelDisplayName
    || step?.responseModel
    || step?.model
    || step?.modelId
    || '';
  return String(gmModel || stepModel || fallbackRunningModel || '').trim();
}

function extractStepUsage(step) {
  if (step?.input_tokens != null || step?.output_tokens != null || step?.cache_read_tokens != null) {
    const input = Number(step.input_tokens || 0);
    const cache = Number(step.cache_read_tokens || 0);
    const output = Number(step.output_tokens || 0);
    const thinking = Number(step.thinking_output_tokens || 0);
    return { input, cache, output, thinking, response: Math.max(0, output - thinking) };
  }
  const u = step?.chatModel?.usage || step?.usage;
  if (u && typeof u === 'object') {
    const input = Number(u.inputTokens ?? u.input_tokens ?? 0);
    const cache = Number(u.cacheReadTokens ?? u.cache_read_tokens ?? 0);
    const output = Number(u.outputTokens ?? u.output_tokens ?? 0);
    const thinking = Number(u.thinkingOutputTokens ?? u.thinking_output_tokens ?? 0);
    const response = Number(u.responseOutputTokens ?? u.response_output_tokens ?? Math.max(0, output - thinking));
    return { input, cache, output, thinking, response };
  }
  return { input: 0, cache: 0, output: 0, thinking: 0, response: 0 };
}

function isModelTurnStep(step) {
  const type = String(step?.type || '');
  if (type === 'USER_INPUT' || type === 'CHECKPOINT' || type === 'ERROR_MESSAGE' || step?.checkpoint) {
    return false;
  }
  if (type === 'PLANNER_RESPONSE') return true;
  const u = extractStepUsage(step);
  return (u.input + u.cache + u.output) > 0;
}

const annotationFileCache = new Map();
const convWorkspaceCache = new Map();
const scanSnapCache = new Map();

function readConversationAnnotationsMap() {
  const annDir = join(findAppDataDir(), 'annotations');
  const map = new Map();
  if (!existsSync(annDir)) return map;
  try {
    for (const f of readdirSync(annDir)) {
      if (!f.endsWith('.pbtxt')) continue;
      const id = f.slice(0, -6);
      if (!CONV_ID_RE.test(id)) continue;
      const p = join(annDir, f);
      try {
        const st = statSync(p);
        let cached = annotationFileCache.get(p);
        if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
          const raw = readFileSync(p, 'utf-8');
          const mView = raw.match(/last_user_view_time:\s*\{\s*seconds:\s*(\d+)(?:\s+nanos:\s*(\d+))?\s*\}/);
          let viewTimeMs = 0;
          if (mView) {
            viewTimeMs = Number(mView[1]) * 1000 + Math.round(Number(mView[2] || 0) / 1e6);
          }
          const mTitle = raw.match(/title:\s*"((?:[^"\\]|\\.)*)"/);
          const annTitle = mTitle ? mTitle[1].replace(/\\"/g, '"').trim() : '';
          cached = { mtimeMs: st.mtimeMs, size: st.size, viewTimeMs, annTitle };
          annotationFileCache.set(p, cached);
        }
        map.set(id, cached);
      } catch {}
    }
  } catch {}
  return map;
}

export function listRecentConversations(limit = 24) {
  const annMap = readConversationAnnotationsMap();
  const roots = [
    { dir: join(findAppDataDir(), 'brain'), source: 'desktop' },
    { dir: join(findCliDataDir(), 'brain'), source: 'cli' }
  ];
  const entries = [];
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    try {
      for (const dirent of readdirSync(root.dir, { withFileTypes: true })) {
        if (!dirent.isDirectory() || !CONV_ID_RE.test(dirent.name)) continue;
        const stdLog = join(root.dir, dirent.name, '.system_generated', 'logs', 'transcript.jsonl');
        const directLog = join(root.dir, dirent.name, 'transcript.jsonl');
        const logPath = existsSync(stdLog) ? stdLog : (existsSync(directLog) ? directLog : '');
        if (!logPath) continue;
        try {
          const st = statSync(logPath);
          if (st.size <= 0) continue;
          const ann = annMap.get(dirent.name) || null;
          entries.push({
            id: dirent.name,
            source: root.source,
            rootDir: root.dir,
            logPath,
            mtimeMs: st.mtimeMs,
            size: st.size,
            viewTimeMs: ann?.viewTimeMs || 0,
            annMtimeMs: ann?.mtimeMs || 0,
            annTitle: ann?.annTitle || ''
          });
        } catch {}
      }
    } catch {}
  }

  const enriched = entries.map((item) => {
    const cacheKey = `${item.mtimeMs}:${item.size}`;
    let meta = recentConvMetaCache.get(item.logPath);
    if (!meta || meta.key !== cacheKey) {
      let title = '';
      let lastContextTokens = 0;
      let turnsCount = 0;
      let hasUserInput = false;
      let firstType = '';
      try {
        const raw = readFileSync(item.logPath, 'utf-8');
        const lines = raw.split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (!firstType && obj.type) firstType = obj.type;
            if (obj.type === 'USER_INPUT') {
              hasUserInput = true;
              if (!title && obj.content) {
                title = extractCleanUserTitle(obj.content);
              }
            }
            if (isModelTurnStep(obj)) {
              const u = extractStepUsage(obj);
              const tot = u.input + u.cache + u.output;
              if (tot > 0) {
                turnsCount++;
                lastContextTokens = tot;
              }
            }
          } catch {}
        }
      } catch {}
      const isSubagent = !hasUserInput && firstType === 'SYSTEM_MESSAGE' && !item.viewTimeMs;
      meta = { key: cacheKey, title, lastContextTokens, turnsCount, isSubagent };
      if (recentConvMetaCache.size > 2000) {
        const firstK = recentConvMetaCache.keys().next().value;
        if (firstK) recentConvMetaCache.delete(firstK);
      }
      recentConvMetaCache.set(item.logPath, meta);
    }

    const effectiveActiveMs = meta.isSubagent
      ? 0
      : Math.max(item.viewTimeMs || 0, item.mtimeMs || 0);

    return {
      id: item.id,
      shortId: item.id.slice(0, 8),
      source: item.source,
      title: meta.title || item.annTitle || `会话 ${item.id.slice(0, 8)}`,
      annTitle: item.annTitle || '',
      isSubagent: Boolean(meta.isSubagent),
      lastContextTokens: meta.lastContextTokens || 0,
      turnsCount: meta.turnsCount || 0,
      viewTimeMs: item.viewTimeMs || 0,
      annMtimeMs: item.annMtimeMs || 0,
      effectiveActiveMs,
      updatedAtMs: item.mtimeMs,
      updatedAt: new Date(item.mtimeMs).toISOString()
    };
  });

  enriched.sort((a, b) => {
    if (a.isSubagent !== b.isSubagent) return a.isSubagent ? 1 : -1;
    if (b.effectiveActiveMs !== a.effectiveActiveMs) return b.effectiveActiveMs - a.effectiveActiveMs;
    return b.updatedAtMs - a.updatedAtMs;
  });

  return enriched.slice(0, limit);
}

function resolveActiveConversationId(recentConversations) {
  if (!Array.isArray(recentConversations) || !recentConversations.length) return '';
  const hint = readActiveSessionHint();

  // 1. Explicit conversation lock chosen in `#conv-select`
  if (hint.pinnedConvId && recentConversations.some((c) => c.id === hint.pinnedConvId)) {
    return hint.pinnedConvId;
  }

  const topConvs = recentConversations.filter((c) => !c.isSubagent);
  const pool = topConvs.length ? topConvs : recentConversations;

  // 2. Host UI view-switch tracking (`annotations/<id>.pbtxt` `last_user_view_time`)
  //    Handles Antigravity's `BatchRecordUserLastUpdateTimes`, which writes the SAME
  //    timestamp to `{previousConv, newlyEnteredConv}` when the user switches tabs!
  let maxViewMs = 0;
  for (const c of pool) {
    if ((c.viewTimeMs || 0) > maxViewMs) maxViewMs = c.viewTimeMs;
  }

  let viewWinner = null;
  if (maxViewMs > 0) {
    const tied = pool.filter((c) => Math.abs((c.viewTimeMs || 0) - maxViewMs) <= 80);
    if (maxViewMs > (hint.lastBatchViewMs || 0)) {
      viewWinner = (tied.length > 1 && hint.resolvedConvId)
        ? (tied.find((c) => c.id !== hint.resolvedConvId) || tied[0])
        : tied[0];
      if (viewWinner) {
        updateActiveSessionHint({
          resolvedConvId: viewWinner.id,
          lastBatchViewMs: maxViewMs
        });
      }
    } else {
      viewWinner = tied.find((c) => c.id === hint.resolvedConvId) || tied[0];
    }
  }

  // 3. Compare most recent UI view switch vs explicit Aux Pane click vs latest new turn (e.g. agy CLI)
  const candidates = [];
  if (viewWinner) {
    candidates.push({ id: viewWinner.id, ts: maxViewMs });
  }
  if (hint.userFocusedConvId && hint.userFocusedAt > 0 && pool.some((c) => c.id === hint.userFocusedConvId)) {
    candidates.push({ id: hint.userFocusedConvId, ts: hint.userFocusedAt });
  }
  const newestTurnConv = [...pool].sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
  if (newestTurnConv) {
    candidates.push({ id: newestTurnConv.id, ts: newestTurnConv.updatedAtMs });
  }

  candidates.sort((a, b) => b.ts - a.ts);
  const chosenId = candidates[0]?.id || pool[0]?.id || '';
  if (chosenId && chosenId !== hint.resolvedConvId && (!maxViewMs || candidates[0]?.ts > maxViewMs)) {
    updateActiveSessionHint({ resolvedConvId: chosenId });
  }
  return chosenId;
}

// ---------------------------------------------------------------------------
// Active Conversation Context & Audit Scanner
// ---------------------------------------------------------------------------

async function fetchGeneratorMetadataForConv(convId, force = false) {
  const cached = convGenMetaCache.get(convId);
  if (!force && cached && Date.now() - cached.at < 2500) {
    return cached;
  }
  const res = await callLanguageServer('GetCascadeTrajectoryGeneratorMetadata', {
    cascadeId: convId,
    generatorMetadataOffset: 0,
    includeMessages: false
  });
  if (!res || !Array.isArray(res.generatorMetadata)) {
    return cached || null;
  }
  const callsByStep = new Map();
  const generatorList = res.generatorMetadata;
  for (const entry of generatorList) {
    const indices = entry.stepIndices || (entry.stepIndex != null ? [entry.stepIndex] : []);
    for (const idx of indices) {
      callsByStep.set(Number(idx), entry);
    }
  }
  const value = { at: Date.now(), generatorList, callsByStep };
  convGenMetaCache.set(convId, value);
  return value;
}

function extractContextBreakdown(contextWindowMetadata) {
  const groups = contextWindowMetadata?.tokenBreakdown?.groups;
  if (!Array.isArray(groups) || !groups.length) return null;
  const total = Number(contextWindowMetadata.totalTokens || contextWindowMetadata.estimatedTokensUsed || 0);
  const parsedGroups = groups.map((g) => {
    const numTokens = Number(g.numTokens || 0);
    const children = Array.isArray(g.children)
      ? g.children
          .map((c) => ({ name: String(c.name || ''), tokens: Number(c.numTokens || 0) }))
          .filter((c) => c.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
      : [];
    const labelMap = {
      'System Prompt': '系统提示与规则',
      Tools: '工具定义 Schema',
      'Chat Messages': '对话与工具历史'
    };
    const slicedChildren = g.name === 'Chat Messages' ? children.slice(0, 8) : children.slice(0, 18);
    return {
      key: g.type || g.name || 'group',
      name: g.name || '未命名分组',
      label: labelMap[g.name] || g.name || '上下文分组',
      tokens: numTokens,
      percent: total > 0 ? Number(((numTokens / total) * 100).toFixed(1)) : 0,
      children: slicedChildren,
      topChildren: slicedChildren,
      childrenCount: children.length
    };
  });
  return {
    totalTokens: total,
    maxContextTokens: Number(contextWindowMetadata.maxContextTokens || 0) || null,
    groups: parsedGroups
  };
}

export async function scanConversation(requestedConvId = '', options = {}) {
  const force = Boolean(options.force);
  if (force) {
    fileAuditCache.clear();
    scanSnapCache.clear();
  }

  const recentConversations = listRecentConversations(24);
  const convId = (requestedConvId && CONV_ID_RE.test(requestedConvId))
    ? requestedConvId
    : resolveActiveConversationId(recentConversations);

  if (!convId) {
    return {
      ok: true,
      conversationId: null,
      recentConversations: [],
      empty: true,
      etag: 'empty'
    };
  }

  const desktopLogsDir = join(findAppDataDir(), 'brain', convId, '.system_generated', 'logs');
  const cliLogsDir = join(findCliDataDir(), 'brain', convId, '.system_generated', 'logs');
  const cliDirectLog = join(findCliDataDir(), 'brain', convId, 'transcript.jsonl');
  const brainBase = existsSync(desktopLogsDir) ? desktopLogsDir : cliLogsDir;
  const fullPath = join(brainBase, 'transcript_full.jsonl');
  const compactPath = join(brainBase, 'transcript.jsonl');
  const targetLogPath = (existsSync(fullPath) && statSync(fullPath).size <= 32 * 1024 * 1024)
    ? fullPath
    : (existsSync(compactPath) ? compactPath : cliDirectLog);

  let logStatMtime = 0;
  let logStatSize = 0;
  if (existsSync(targetLogPath)) {
    try {
      const st = statSync(targetLogPath);
      logStatMtime = st.mtimeMs;
      logStatSize = st.size;
    } catch {}
  }

  const host = await getHostUserStatus(force);

  const snapCacheKey = `${convId}|${logStatMtime}|${logStatSize}|${host.sig}|${Math.floor(Date.now() / 15000)}`;
  if (!force && scanSnapCache.has(convId)) {
    const hit = scanSnapCache.get(convId);
    if (hit.key === snapCacheKey) {
      return {
        ...hit.snap,
        recentConversations
      };
    }
  }

  const genMetaBundle = await fetchGeneratorMetadataForConv(convId, force);

  // Parse transcript steps
  const groups = {
    user: emptyMeasure(),
    assistant: emptyMeasure(),
    thinking: emptyMeasure(),
    tools: emptyMeasure(),
    summaries: emptyMeasure(),
    system: emptyMeasure(),
    definitions: emptyMeasure()
  };
  const mediaMap = new Map();
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCallsCount = 0;
  let totalSteps = 0;
  let activeSettingModel = '';
  let lastSettingStepIdx = -1;
  let latestStepError = null;
  let conversationTitle = '';
  let logMtimeMs = 0;

  const rawSteps = [];
  if (existsSync(targetLogPath)) {
    const st = statSync(targetLogPath);
    logMtimeMs = st.mtimeMs;
    const lines = readFileSync(targetLogPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        rawSteps.push(JSON.parse(line));
      } catch {}
    }
  }

  totalSteps = rawSteps.length;
  const stepMetaMap = new Map();
  let lastTranscriptPlannerArrayIdx = -1;

  const summarizeToolNames = (toolCalls) => {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
    const counts = new Map();
    for (const tc of toolCalls) {
      const rawName = String(tc?.name || tc?.tool_name || tc?.function?.name || 'tool').trim();
      const shortName = rawName.replace(/^default_api:/, '');
      counts.set(shortName, (counts.get(shortName) || 0) + 1);
    }
    return [...counts.entries()].slice(0, 6).map(([name, cnt]) => (cnt > 1 ? `${name} ×${cnt}` : name));
  };

  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    const sIdx = Number(step.step_index ?? i);
    const type = step.type || '';
    const contentStr = typeof step.content === 'string' ? step.content : '';

    if (type === 'USER_INPUT') {
      userMessages++;
      if (!conversationTitle && contentStr) {
        conversationTitle = extractCleanUserTitle(contentStr);
      }
      const switchedModel = parseModelSettingFromText(contentStr);
      if (switchedModel) {
        activeSettingModel = switchedModel;
        lastSettingStepIdx = sIdx;
      }
      addMeasure(groups.user, measureText(contentStr));
    } else if (isModelTurnStep(step)) {
      assistantMessages++;
      addMeasure(groups.assistant, measureText(contentStr));
      if (step.thinking) addMeasure(groups.thinking, measureText(step.thinking));
      const toolBadges = summarizeToolNames(step.tool_calls);
      if (Array.isArray(step.tool_calls) && step.tool_calls.length) {
        toolCallsCount += step.tool_calls.length;
        addMeasure(groups.tools, measureText(JSON.stringify(step.tool_calls)));
      }
      stepMetaMap.set(sIdx, {
        arrayIdx: i,
        createdAt: step.created_at || '',
        tools: toolBadges,
        stepModel: extractStepModel(step, null, ''),
        runningSettingModel: activeSettingModel
      });
      const stepUsage = extractStepUsage(step);
      if ((stepUsage.input || stepUsage.cache || stepUsage.output) && step.status !== 'ERROR') {
        lastTranscriptPlannerArrayIdx = i;
      }
      if (step.status === 'ERROR' && contentStr) {
        latestStepError = { stepIndex: sIdx, text: contentStr };
      }
    } else if (type === 'CHECKPOINT' || step.checkpoint) {
      addMeasure(groups.summaries, measureText(contentStr || step.checkpoint?.sessionSummary || ''));
    } else if (type === 'ERROR_MESSAGE' || step.status === 'ERROR') {
      if (contentStr) latestStepError = { stepIndex: sIdx, text: contentStr };
      addMeasure(groups.tools, measureText(contentStr));
    } else {
      addMeasure(groups.tools, measureText(contentStr));
    }

    if (Array.isArray(step.media)) {
      const mediaSource = type === 'USER_INPUT' ? 'user' : 'assistant';
      for (const m of step.media) {
        if (!m || (!m.uri && !m.inline_data && !m.inlineData)) continue;
        const uriKey = String(m.uri || `inline-${mediaMap.size}`);
        const prev = mediaMap.get(uriKey);
        if (prev) {
          prev.references++;
        } else {
          mediaMap.set(uriKey, {
            uri: uriKey,
            inlineData: m.inline_data || m.inlineData || null,
            mime: m.mime_type || m.mimeType || '',
            name: m.description || uriKey.split(/[\\/]/).pop() || '附件',
            references: 1,
            source: mediaSource
          });
        }
      }
    }
  }

  // Build turn-by-turn metrics combining GeneratorMetadata + Transcript steps
  const turns = [];
  let sessionCostUSD = 0;

  if (genMetaBundle?.generatorList?.length) {
    let prevTotal = 0;
    for (let idx = 0; idx < genMetaBundle.generatorList.length; idx++) {
      const gm = genMetaBundle.generatorList[idx];
      const cm = gm.chatModel || {};
      const lastRetry = Array.isArray(cm.retryInfos) && cm.retryInfos.length ? cm.retryInfos[cm.retryInfos.length - 1] : null;
      const usage = lastRetry?.usage || cm.usage || {};
      const input = Number(usage.inputTokens || 0);
      const cache = Number(usage.cacheReadTokens || 0);
      const output = Number(usage.outputTokens || 0);
      const thinking = Number(usage.thinkingOutputTokens || 0);
      const responseTokens = Number(usage.responseOutputTokens ?? Math.max(0, output - thinking));
      const total = input + cache + output;
      const stepIdx = gm.stepIndices?.[0] ?? null;
      const sMeta = stepIdx !== null ? stepMetaMap.get(Number(stepIdx)) : null;
      const rawModel = extractStepModel(null, gm, sMeta?.stepModel || sMeta?.runningSettingModel || activeSettingModel);
      const modelKey = normalizeModelId(rawModel, host.dynamicModelMap);
      const displayModel = rawModel ? formatModelDisplayName(rawModel, modelKey) : '';

      const ttft = parseDurationSec(cm.timeToFirstToken);
      const streamingSec = parseDurationSec(cm.streamingDuration);
      const duration = ttft !== null && streamingSec !== null ? ttft + streamingSec : (ttft ?? streamingSec ?? null);
      const tps = output > 0 && duration && duration > 0 ? Number((output / duration).toFixed(1)) : null;
      const streamTokBase = thinking > 0 && responseTokens > 0 ? responseTokens : output;
      const streamingTps = streamTokBase > 0 && streamingSec && streamingSec >= 0.4
        ? Number((streamTokBase / streamingSec).toFixed(1))
        : null;

      const costInfo = calculateRequestApiCost(
        {
          model: rawModel,
          modelKey,
          inputTokens: input,
          cacheTokens: cache,
          outputTokens: output,
          thinkingTokens: thinking,
          date: sMeta?.createdAt
        },
        host.dynamicModelMap
      );
      if (costInfo.isPriced && costInfo.costUSD) {
        sessionCostUSD += costInfo.costUSD;
      }

      const deltaTokens = total > 0 ? (prevTotal > 0 ? total - prevTotal : total) : 0;
      if (total > 0) prevTotal = total;
      const promptSum = input + cache;
      const turnCachePct = promptSum > 0 ? Number(((cache / promptSum) * 100).toFixed(1)) : 0;

      const ctxMeta = cm.chatStartMetadata?.contextWindowMetadata || null;
      turns.push({
        turnIndex: idx + 1,
        stepIndex: stepIdx,
        _arrayIdx: sMeta?.arrayIdx ?? -1,
        createdAt: sMeta?.createdAt || '',
        tools: sMeta?.tools || [],
        model: displayModel || '未记录模型',
        hasRecordedModel: Boolean(rawModel),
        modelKey,
        inputTokens: input,
        cacheTokens: cache,
        outputTokens: output,
        thinkingTokens: thinking,
        responseTokens,
        totalTokens: total,
        deltaTokens,
        cacheHitPercent: turnCachePct,
        budget: Number(ctxMeta?.maxContextTokens || 0) || null,
        estimate: Number(ctxMeta?.estimatedTokensUsed || 0) || null,
        ttft: ttft !== null ? Number(ttft.toFixed(2)) : null,
        streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
        duration: duration !== null ? Number(duration.toFixed(2)) : null,
        tps,
        streamingTps,
        costUSD: costInfo.costUSD ?? 0,
        isPriced: costInfo.isPriced,
        error: String(lastRetry?.error || cm.error || ''),
        contextBreakdown: idx === genMetaBundle.generatorList.length - 1 ? extractContextBreakdown(ctxMeta) : null
      });
    }
  } else {
    // Pure transcript fallback when Language Server GeneratorMetadata is unavailable
    let runningModel = '';
    let prevTotal = 0;
    for (let i = 0; i < rawSteps.length; i++) {
      const s = rawSteps[i];
      if (s.type === 'USER_INPUT' && s.content) {
        const m = parseModelSettingFromText(s.content);
        if (m) runningModel = m;
      }
      if (isModelTurnStep(s)) {
        const { input, cache, output, thinking, response: responseTokens } = extractStepUsage(s);
        const total = input + cache + output;
        if (total <= 0) continue;

        // Estimate duration from next step timestamp delta or log mtime on final step
        let duration = null;
        const startMs = s.created_at ? Date.parse(s.created_at) : NaN;
        const nextStep = rawSteps[i + 1];
        const endMs = nextStep?.created_at
          ? Date.parse(nextStep.created_at)
          : (i === rawSteps.length - 1 && logMtimeMs > startMs ? logMtimeMs : NaN);
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && (endMs - startMs) < 300_000) {
          duration = Number(((endMs - startMs) / 1000).toFixed(2));
        }
        const tps = output > 0 && duration && duration > 0.1 ? Number((output / duration).toFixed(1)) : null;
        const rawModel = extractStepModel(s, null, runningModel);
        const modelKey = normalizeModelId(rawModel, host.dynamicModelMap);
        const displayModel = rawModel ? formatModelDisplayName(rawModel, modelKey) : '';
        const costInfo = calculateRequestApiCost(
          {
            model: rawModel,
            modelKey,
            inputTokens: input,
            cacheTokens: cache,
            outputTokens: output,
            thinkingTokens: thinking,
            date: s.created_at
          },
          host.dynamicModelMap
        );
        if (costInfo.isPriced && costInfo.costUSD) {
          sessionCostUSD += costInfo.costUSD;
        }
        const sIdx = Number(s.step_index ?? i);
        const sMeta = stepMetaMap.get(sIdx);
        const deltaTokens = prevTotal > 0 ? total - prevTotal : total;
        prevTotal = total;
        const promptSum = input + cache;
        const turnCachePct = promptSum > 0 ? Number(((cache / promptSum) * 100).toFixed(1)) : 0;

        turns.push({
          turnIndex: turns.length + 1,
          stepIndex: sIdx,
          _arrayIdx: i,
          createdAt: s.created_at || '',
          tools: sMeta?.tools || [],
          model: displayModel || '未记录模型',
          hasRecordedModel: Boolean(rawModel),
          modelKey,
          inputTokens: input,
          cacheTokens: cache,
          outputTokens: output,
          thinkingTokens: thinking,
          responseTokens,
          totalTokens: total,
          deltaTokens,
          cacheHitPercent: turnCachePct,
          budget: null,
          estimate: null,
          ttft: null,
          streamingSec: null,
          duration,
          tps,
          streamingTps: null,
          costUSD: costInfo.costUSD ?? 0,
          isPriced: costInfo.isPriced,
          error: s.status === 'ERROR' ? String(s.content || '请求报错') : '',
          contextBreakdown: null
        });
      }
    }
  }

  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const latestValidTurn = [...turns].reverse().find((t) => t.totalTokens > 0 && !t.error) || latestTurn;

  // Session cumulative throughput & session-wide TPS stats
  const sessionTotals = {
    inputTokens: 0,
    cacheTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    cacheHitPercent: null
  };
  const validTpsValues = [];
  for (const t of turns) {
    sessionTotals.inputTokens += t.inputTokens || 0;
    sessionTotals.cacheTokens += t.cacheTokens || 0;
    sessionTotals.outputTokens += t.outputTokens || 0;
    sessionTotals.thinkingTokens += t.thinkingTokens || 0;
    sessionTotals.responseTokens += t.responseTokens || 0;
    sessionTotals.totalTokens += t.totalTokens || 0;
    if (typeof t.tps === 'number' && t.tps > 0) validTpsValues.push(t.tps);
  }
  const cumPrompt = sessionTotals.inputTokens + sessionTotals.cacheTokens;
  if (cumPrompt > 0) {
    sessionTotals.cacheHitPercent = Number(((sessionTotals.cacheTokens / cumPrompt) * 100).toFixed(1));
  }
  const avgTps = validTpsValues.length > 0
    ? Number((validTpsValues.reduce((a, b) => a + b, 0) / validTpsValues.length).toFixed(1))
    : null;
  const peakTps = validTpsValues.length > 0
    ? Number(Math.max(...validTpsValues).toFixed(1))
    : null;

  // Populate system & tool definition token estimates from server contextBreakdown if present
  const contextBreakdown = latestTurn?.contextBreakdown || null;
  if (contextBreakdown?.groups?.length) {
    const sysG = contextBreakdown.groups.find((g) => g.name === 'System Prompt');
    const toolG = contextBreakdown.groups.find((g) => g.name === 'Tools');
    if (sysG) groups.system = { chars: sysG.tokens * 4, bytes: sysG.tokens * 4, low: sysG.tokens, high: sysG.tokens };
    if (toolG) groups.definitions = { chars: toolG.tokens * 4, bytes: toolG.tokens * 4, low: toolG.tokens, high: toolG.tokens };
  }

  // Inspect attachments
  const attachments = [...mediaMap.values()].map(inspectAttachmentItem);
  const attachmentTotal = emptyMeasure();
  for (const att of attachments) {
    const mult = att.references || 1;
    addMeasure(attachmentTotal, {
      chars: (att.chars || 0) * mult,
      bytes: (att.bytes || 0) * mult,
      low: (att.low || 0) * mult,
      high: (att.high || 0) * mult
    });
  }

  const localTotal = emptyMeasure();
  for (const g of Object.values(groups)) addMeasure(localTotal, g);
  addMeasure(localTotal, attachmentTotal);

  const activeErrorText = latestTurn?.error || (
    latestStepError && (!latestTurn?.stepIndex || latestStepError.stepIndex >= latestTurn.stepIndex)
      ? latestStepError.text
      : ''
  );
  const switchedAfterLatestTurn = Boolean(
    activeSettingModel &&
    lastSettingStepIdx >= 0 &&
    (latestTurn?.stepIndex == null || lastSettingStepIdx > Number(latestTurn.stepIndex))
  );
  const currentModelKey = switchedAfterLatestTurn
    ? (normalizeModelId(activeSettingModel, host.dynamicModelMap) || null)
    : (latestTurn?.modelKey || normalizeModelId(activeSettingModel, host.dynamicModelMap) || null);
  const currentModelDisplay = switchedAfterLatestTurn
    ? formatModelDisplayName(activeSettingModel, currentModelKey)
    : (latestTurn?.hasRecordedModel
        ? latestTurn.model
        : (activeSettingModel ? formatModelDisplayName(activeSettingModel, currentModelKey) : '未记录模型'));
  const errorInfo = classifyRequestError(activeErrorText, {
    currentModel: currentModelDisplay,
    clientModelConfigs: host.modelConfigs,
    quotaSummaryGroups: host.quotaSummaryGroups
  });

  // Compute pending unsent tokens appended after the last completed model turn
  let lastCoveredArrayIdx = lastTranscriptPlannerArrayIdx;
  if (latestValidTurn && latestValidTurn.totalTokens > 0 && !latestValidTurn.error) {
    lastCoveredArrayIdx = Math.max(lastCoveredArrayIdx, latestValidTurn._arrayIdx ?? -1);
  }
  if (errorInfo.kind === 'context_overflow' && latestTurn?.estimate > 0) {
    lastCoveredArrayIdx = Math.max(lastCoveredArrayIdx, latestTurn._arrayIdx ?? -1);
  }
  const pendingMeasure = emptyMeasure();
  let pendingStepsCount = 0;
  if (lastCoveredArrayIdx >= 0 && lastCoveredArrayIdx < rawSteps.length - 1) {
    for (let i = lastCoveredArrayIdx + 1; i < rawSteps.length; i++) {
      const stp = rawSteps[i];
      if (stp.type === 'ERROR_MESSAGE' || stp.status === 'ERROR') continue;
      if (typeof stp.content === 'string' && stp.content) {
        addMeasure(pendingMeasure, measureText(stp.content));
        pendingStepsCount++;
      }
    }
  }
  const pendingTokens = pendingStepsCount > 0
    ? Math.round((pendingMeasure.low + pendingMeasure.high) / 2)
    : 0;

  const baseUsedTokens = errorInfo.kind === 'context_overflow'
    ? (latestTurn?.estimate || latestValidTurn?.totalTokens || null)
    : (latestValidTurn?.totalTokens ?? latestTurn?.estimate ?? null);
  const usedTokens = baseUsedTokens !== null ? baseUsedTokens + pendingTokens : null;
  const budgetTokens = latestTurn?.budget || latestValidTurn?.budget || null;
  const budgetSource = budgetTokens ? 'server' : 'unknown';
  const remainingTokens = usedTokens !== null && budgetTokens !== null && budgetTokens > 0
    ? Math.max(0, budgetTokens - usedTokens)
    : null;
  const usedPercent = usedTokens !== null && budgetTokens !== null && budgetTokens > 0
    ? Number(((usedTokens / budgetTokens) * 100).toFixed(1))
    : null;
  const promptTotal = (latestValidTurn?.inputTokens || 0) + (latestValidTurn?.cacheTokens || 0);
  const cacheHitPercent = promptTotal > 0
    ? Number((((latestValidTurn?.cacheTokens || 0) / promptTotal) * 100).toFixed(1))
    : null;

  const modelQuota = resolveModelQuota(currentModelDisplay, host.modelConfigs, host.quotaSummaryGroups);
  const unknownAttachmentsCount = attachments.filter((a) => a.status !== 'parsed').length;

  // Resolve workspace URI via official agentapi if available (cached per conversation)
  let workspacePath = convWorkspaceCache.get(convId) ?? null;
  if (workspacePath === null && !convWorkspaceCache.has(convId)) {
    try {
      const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
      if (exe) {
        const out = execFileSync(exe, ['agentapi', 'get-conversation-metadata', convId], {
          encoding: 'utf-8',
          timeout: 2000
        });
        const parsedMeta = JSON.parse(out);
        const uri = parsedMeta?.response?.conversationMetadata?.metadata?.workspaceUris?.[0] || '';
        if (uri.startsWith('file://')) workspacePath = fileURLToPath(uri);
      }
    } catch {}
    convWorkspaceCache.set(convId, workspacePath);
  }

  const resolvedTitle = conversationTitle || `会话 ${convId.slice(0, 8)}`;
  const contextPayload = {
    model: currentModelDisplay,
    modelKey: currentModelKey,
    used: usedTokens,
    baseUsed: baseUsedTokens,
    pendingTokens,
    pendingStepsCount,
    actual: latestValidTurn?.totalTokens ?? null,
    estimate: latestTurn?.estimate ?? null,
    budget: budgetTokens,
    budgetSource,
    remaining: remainingTokens,
    percent: usedPercent,
    inputTokens: latestValidTurn?.inputTokens ?? null,
    cacheTokens: latestValidTurn?.cacheTokens ?? null,
    outputTokens: latestValidTurn?.outputTokens ?? null,
    thinkingTokens: latestValidTurn?.thinkingTokens ?? 0,
    responseTokens: latestValidTurn?.responseTokens ?? (latestValidTurn?.outputTokens ?? 0),
    cacheHitPercent,
    roundCostUSD: Number((latestValidTurn?.costUSD || 0).toFixed(5)),
    sessionCostUSD: Number(sessionCostUSD.toFixed(4)),
    isPriced: Boolean(latestValidTurn?.isPriced),
    error: errorInfo,
    quota: modelQuota,
    breakdown: contextBreakdown,
    sessionTotals
  };
  const speedPayload = latestValidTurn ? {
    tps: latestValidTurn.tps,
    streamingTps: latestValidTurn.streamingTps,
    avgTps,
    peakTps,
    duration: latestValidTurn.duration,
    ttft: latestValidTurn.ttft,
    streamingSec: latestValidTurn.streamingSec,
    outputTokens: latestValidTurn.outputTokens,
    thinkingTokens: latestValidTurn.thinkingTokens,
    responseTokens: latestValidTurn.responseTokens,
    isServerExact: Boolean(genMetaBundle?.generatorList?.length)
  } : null;
  const sparklinePayload = turns.slice(-24).map((t) => ({
    turn: t.turnIndex,
    total: t.totalTokens,
    delta: t.deltaTokens,
    cache: t.cacheTokens,
    output: t.outputTokens,
    tps: t.tps,
    costUSD: t.costUSD
  }));
  const turnsPayload = turns.slice(-40).reverse().map(({ contextBreakdown: _cb, hasRecordedModel: _hrm, _arrayIdx: _ai, ...rest }) => rest);
  const auditPayload = {
    totalSteps,
    turnsCount: turns.length,
    userMessages,
    assistantMessages,
    toolCallsCount,
    groups,
    attachmentTotal,
    localTotal,
    attachments,
    unknownAttachmentsCount
  };

  const etag = computeContentEtag('ctx', {
    conversationId: convId,
    conversationTitle: resolvedTitle,
    workspacePath,
    quotas: host.quotas || [],
    quotaState: toStableQuotaState(host.quotaStatus),
    context: contextPayload,
    speed: speedPayload,
    sparkline: sparklinePayload,
    turns: turnsPayload,
    audit: auditPayload
  });

  const resultSnap = {
    ok: true,
    etag,
    scannedAt: Date.now(),
    conversationId: convId,
    conversationTitle: resolvedTitle,
    workspacePath,
    recentConversations,
    quotas: host.quotas || [],
    quotaStatus: host.quotaStatus,
    context: contextPayload,
    speed: speedPayload,
    sparkline: sparklinePayload,
    turns: turnsPayload,
    audit: auditPayload
  };
  if (scanSnapCache.size > 32) {
    const oldest = scanSnapCache.keys().next().value;
    if (oldest) scanSnapCache.delete(oldest);
  }
  scanSnapCache.set(convId, { key: snapCacheKey, snap: resultSnap });
  return resultSnap;
}

// ---------------------------------------------------------------------------
// Global Token History & Multi-Source Cost Aggregator
// ---------------------------------------------------------------------------

function walkTranscriptFiles(rootBrainDir, sourceName) {
  const jobs = [];
  if (!existsSync(rootBrainDir)) return jobs;
  const visited = new Set();

  const walk = (dir, depth) => {
    if (depth > 4) return;
    let real;
    try { real = realpathSync(dir); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (SKIP_SCAN_DIRS.has(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory() || ent.isSymbolicLink()) {
        if (depth === 0) {
          const fastStd = join(full, '.system_generated', 'logs', 'transcript.jsonl');
          const fastDirect = join(full, 'transcript.jsonl');
          if (existsSync(fastStd)) {
            jobs.push({ path: fastStd, convId: ent.name, source: sourceName });
            continue;
          }
          if (existsSync(fastDirect)) {
            jobs.push({ path: fastDirect, convId: ent.name, source: sourceName });
            continue;
          }
        }
        walk(full, depth + 1);
      } else if (ent.name === 'transcript.jsonl') {
        jobs.push({ path: full, convId: basename(dirname(full)), source: sourceName });
      }
    }
  };

  walk(rootBrainDir, 0);
  return jobs;
}

function countSessionFiles(convDir) {
  if (!existsSync(convDir)) return 0;
  let count = 0;
  try {
    for (const name of readdirSync(convDir)) {
      const lower = name.toLowerCase();
      if (lower.endsWith('-wal') || lower.endsWith('-shm') || lower.endsWith('-journal') || lower.endsWith('.tmp')) continue;
      if (lower.endsWith('.pb') || lower.endsWith('.db')) count++;
    }
  } catch {}
  return count;
}

export async function collectTokenHistory(options = {}) {
  const force = Boolean(options.force);
  if (force) {
    transcriptHistCache.clear();
  }
  const host = await getHostUserStatus(force);
  if (
    !force &&
    cachedHistoryResult.data &&
    cachedHistoryResult.hostSig === host.sig &&
    Date.now() - cachedHistoryResult.at < 12_000
  ) {
    return cachedHistoryResult.data;
  }

  const rawSettings = loadRawSettings();
  const acctKey = host.plan?.accountKey || rawSettings.lastAccountKey || 'default';
  const customPlan = rawSettings.accounts[acctKey] || rawSettings.accounts.default || null;
  const effectivePlan = resolveEffectivePlanStatus(host.plan, customPlan);

  const agDir = findAppDataDir();
  const cliDir = findCliDataDir();
  const desktopJobs = walkTranscriptFiles(join(agDir, 'brain'), 'desktop');
  const cliJobs = walkTranscriptFiles(join(cliDir, 'brain'), 'cli');
  const allJobs = [...desktopJobs, ...cliJobs];

  const desktopSessionFiles = countSessionFiles(join(agDir, 'conversations'));
  const cliSessionFiles = countSessionFiles(join(cliDir, 'conversations'));

  const dailyBySource = { all: {}, desktop: {}, cli: {} };
  const requestsBySource = { all: [], desktop: [], cli: [] };
  const seenEvents = new Set();
  let firstUseDate = null;

  const trackDate = (d) => {
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      if (!firstUseDate || d < firstUseDate) firstUseDate = d;
    }
  };

  const addDaily = (bucketMap, dateKey, inp, cap, outp, pricedCost, refCost) => {
    if (!bucketMap[dateKey]) {
      bucketMap[dateKey] = { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0 };
    }
    const b = bucketMap[dateKey];
    b.total += inp + cap + outp;
    b.input += inp;
    b.cache += cap;
    b.output += outp;
    b.steps += 1;
    b.costUSD = Number((b.costUSD + pricedCost).toFixed(6));
    b.refCostUSD = Number((b.refCostUSD + refCost).toFixed(6));
  };

  for (let idx = 0; idx < allJobs.length; idx++) {
    const job = allJobs[idx];
    if (idx > 0 && idx % 20 === 0) {
      await new Promise((r) => setImmediate(r));
    }
    try {
      const st = statSync(job.path);
      let cached = transcriptHistCache.get(job.path);
      const genCached = convGenMetaCache.get(job.convId);

      if (!cached || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs || (genCached && !cached.enrichedWithGen)) {
        const records = [];
        let activeModel = '';
        const lines = readFileSync(job.path, 'utf-8').split(/\r?\n/);

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx];
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }

          if (ev.type === 'USER_INPUT' && ev.content) {
            const switched = parseModelSettingFromText(ev.content);
            if (switched) activeModel = switched;
          }

          let dateKey = null;
          if (ev.created_at) {
            const dt = new Date(ev.created_at);
            if (!Number.isNaN(dt.getTime())) dateKey = formatLocalDateKey(dt);
          }
          if (dateKey) trackDate(dateKey);

          if (!isModelTurnStep(ev)) continue;
          const { input: inp, cache: cap, output: outp, thinking } = extractStepUsage(ev);
          const tot = inp + cap + outp;
          if (tot <= 0 || !dateKey) continue;

          const stepNum = Number(ev.step_index ?? lineIdx);
          const gmEntry = genCached?.callsByStep?.get(stepNum);
          const rawModel = extractStepModel(ev, gmEntry, activeModel);
          const eventId = String(ev.callId || ev.responseId || `${job.convId}#${stepNum}`);

          records.push({
            eventId,
            source: job.source,
            convId: job.convId,
            date: dateKey,
            created_at: ev.created_at || dateKey,
            model: rawModel,
            inputTokens: inp,
            cacheTokens: cap,
            outputTokens: outp,
            thinkingTokens: thinking,
            totalTokens: tot
          });
        }

        cached = {
          size: st.size,
          mtimeMs: st.mtimeMs,
          enrichedWithGen: Boolean(genCached),
          records
        };
        if (transcriptHistCache.size > 1200) {
          const firstKey = transcriptHistCache.keys().next().value;
          if (firstKey) transcriptHistCache.delete(firstKey);
        }
        transcriptHistCache.set(job.path, cached);
      }

      for (const rec of cached.records) {
        trackDate(rec.date);
        if (seenEvents.has(rec.eventId)) continue;
        seenEvents.add(rec.eventId);

        const priced = calculateRequestApiCost(rec, host.dynamicModelMap);
        const refCalc = calculateReferenceCost(rec, 'gemini-3.8-flash', rec.date);
        const pCost = priced.isPriced ? (priced.costUSD || 0) : 0;
        const rCost = refCalc.totalCostUSD || 0;

        addDaily(dailyBySource.all, rec.date, rec.inputTokens, rec.cacheTokens, rec.outputTokens, pCost, rCost);
        addDaily(dailyBySource[rec.source] || dailyBySource.desktop, rec.date, rec.inputTokens, rec.cacheTokens, rec.outputTokens, pCost, rCost);

        requestsBySource.all.push(rec);
        (requestsBySource[rec.source] || requestsBySource.desktop).push(rec);
      }
    } catch {}
  }

  // Optional read-only merge of legacy unallocated daily totals if user previously had token_usage_archive_v2.json
  const legacyV2 = readJsonSafe(join(agDir, 'token_usage_archive_v2.json'), null);
  if (legacyV2?.dailyMapBySource?.legacyUnallocated) {
    for (const [dateKey, lRec] of Object.entries(legacyV2.dailyMapBySource.legacyUnallocated)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !lRec?.total) continue;
      trackDate(dateKey);
      const refCalc = calculateReferenceCost(
        { inputTokens: lRec.input || 0, cacheTokens: lRec.cache || 0, outputTokens: lRec.output || 0, totalTokens: lRec.total || 0 },
        'gemini-3.8-flash',
        dateKey
      );
      addDaily(dailyBySource.all, dateKey, lRec.input || 0, lRec.cache || 0, lRec.output || 0, 0, refCalc.totalCostUSD || 0);
      addDaily(dailyBySource.desktop, dateKey, lRec.input || 0, lRec.cache || 0, lRec.output || 0, 0, refCalc.totalCostUSD || 0);
    }
  }

  const now = new Date();
  const todayKey = formatLocalDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);
  if (!firstUseDate) firstUseDate = todayKey;

  const buildSourceAnalytics = (srcKey) => {
    const dMap = dailyBySource[srcKey] || {};
    const reqs = requestsBySource[srcKey] || [];
    let grandTotal = 0, totalInput = 0, totalCache = 0, totalOutput = 0, totalSteps = 0;
    let todayTokens = 0, monthTokens = 0, yearTokens = 0;
    let monthInput = 0, monthCache = 0, monthOutput = 0, monthSteps = 0;
    let yearActiveDays = 0, monthActiveDays = 0;

    for (const [dKey, v] of Object.entries(dMap)) {
      grandTotal += v.total;
      totalInput += v.input;
      totalCache += v.cache;
      totalOutput += v.output;
      totalSteps += v.steps;
      if (dKey === todayKey) todayTokens += v.total;
      if (dKey.startsWith(monthPrefix)) {
        monthTokens += v.total;
        monthInput += v.input;
        monthCache += v.cache;
        monthOutput += v.output;
        monthSteps += v.steps;
        if (v.total > 0) monthActiveDays++;
      }
      if (dKey.startsWith(yearPrefix)) {
        yearTokens += v.total;
        if (v.total > 0) yearActiveDays++;
      }
    }

    const activeDaysCount = Object.values(dMap).filter((v) => v.total > 0).length;
    const periodReqs = reqs.filter((r) => r.date && r.date.startsWith(monthPrefix));

    const identifiedAll = summarizeApiCost(reqs, host.dynamicModelMap);
    const identifiedPeriod = summarizeApiCost(periodReqs, host.dynamicModelMap);

    const refAll = calculateReferenceCost({ inputTokens: totalInput, cacheTokens: totalCache, outputTokens: totalOutput, totalTokens: grandTotal }, 'gemini-3.8-flash', PRICING_VERIFIED_DATE);
    const refPeriod = calculateReferenceCost({ inputTokens: monthInput, cacheTokens: monthCache, outputTokens: monthOutput, totalTokens: monthTokens }, 'gemini-3.8-flash', PRICING_VERIFIED_DATE);

    // Hybrid = identified priced requests + reference rate for residual unpriced tokens
    const buildHybrid = (ident, refBase) => {
      const resIn = Math.max(0, refBase.inputTokens - ident.byCategory.inputTokens);
      const resCache = Math.max(0, refBase.cacheTokens - ident.byCategory.cacheTokens);
      const resOut = Math.max(0, refBase.outputTokens - ident.byCategory.outputTokens);
      const resCalc = calculateReferenceCost({ inputTokens: resIn, cacheTokens: resCache, outputTokens: resOut }, 'gemini-3.8-flash', PRICING_VERIFIED_DATE);
      return {
        totalCostUSD: Number((ident.pricedCostUSD + resCalc.totalCostUSD).toFixed(4)),
        inputCostUSD: Number((ident.pricedInputCostUSD + resCalc.inputCostUSD).toFixed(4)),
        cacheCostUSD: Number((ident.pricedCacheCostUSD + resCalc.cacheCostUSD).toFixed(4)),
        outputCostUSD: Number((ident.pricedOutputCostUSD + resCalc.outputCostUSD).toFixed(4)),
        knownCostUSD: ident.pricedCostUSD,
        residualCostUSD: resCalc.totalCostUSD,
        residualTokens: resIn + resCache + resOut
      };
    };

    return {
      summary: {
        grandTotalTokens: grandTotal,
        totalInputTokens: totalInput,
        totalCacheTokens: totalCache,
        totalOutputTokens: totalOutput,
        totalSteps,
        todayTokens,
        monthTokens,
        yearTokens,
        monthInput,
        monthCache,
        monthOutput,
        monthSteps,
        activeDaysCount,
        monthActiveDays,
        yearActiveDays
      },
      costs: {
        allTime: {
          reference: refAll,
          identified: identifiedAll,
          hybrid: buildHybrid(identifiedAll, refAll)
        },
        period: {
          reference: refPeriod,
          identified: identifiedPeriod,
          hybrid: buildHybrid(identifiedPeriod, refPeriod)
        }
      }
    };
  };

  const analyticsBySource = {
    all: buildSourceAnalytics('all'),
    desktop: buildSourceAnalytics('desktop'),
    cli: buildSourceAnalytics('cli')
  };

  const desktopConvCount = Math.max(desktopJobs.length, desktopSessionFiles);
  const cliConvCount = Math.max(cliJobs.length, cliSessionFiles);
  const totalConversations = desktopConvCount + cliConvCount;

  const currentPeriod = {
    key: monthPrefix,
    label: `${monthPrefix} 自然月`
  };
  const sources = {
    all: { conversationsCount: totalConversations, transcriptsCount: allJobs.length },
    desktop: { conversationsCount: desktopConvCount, transcriptsCount: desktopJobs.length },
    cli: { dirExists: existsSync(cliDir), conversationsCount: cliConvCount, transcriptsCount: cliJobs.length }
  };
  const { updatedAt: _planUpdatedAt, ...stablePlan } = effectivePlan || {};
  const { updatedAt: _uiUpdatedAt, ...stableUiPrefs } = rawSettings.uiPreferences || {};
  const etag = computeContentEtag('hist', {
    todayKey,
    currentPeriod,
    firstUseDate,
    sources,
    planStatus: stablePlan,
    modelQuotas: host.quotas || [],
    quotaState: toStableQuotaState(host.quotaStatus),
    uiPreferences: stableUiPrefs,
    dailyMapBySource: dailyBySource,
    analyticsBySource
  });

  const result = {
    ok: true,
    etag,
    updatedAt: new Date().toISOString(),
    todayKey,
    currentPeriod,
    firstUseDate,
    sources,
    planStatus: effectivePlan,
    modelQuotas: host.quotas,
    quotaStatus: host.quotaStatus,
    uiPreferences: rawSettings.uiPreferences || {},
    dailyMapBySource: dailyBySource,
    analyticsBySource,
    presets: {
      regions: SUBSCRIPTION_REGIONS_PRESET,
      acquisitions: SUBSCRIPTION_ACQUISITION_PRESETS,
      currencies: Object.entries(CURRENCY_SYMBOLS).map(([code, symbol]) => ({ code, symbol }))
    }
  };

  cachedHistoryResult = { at: Date.now(), hostSig: host.sig, etag, data: result };
  return result;
}

// ---------------------------------------------------------------------------
// Safe CLI Terminal Launcher (macOS / Linux / Windows)
// ---------------------------------------------------------------------------

function resolveCliBinary() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const winCandidates = [
      join(localAppData, 'Programs', 'Antigravity', 'bin', 'agy.cmd'),
      join(localAppData, 'Programs', 'Antigravity', 'bin', 'agy.exe'),
      join(homedir(), '.local', 'bin', 'agy.cmd'),
      join(homedir(), '.local', 'bin', 'agy.exe'),
      join(appData, 'npm', 'agy.cmd')
    ];
    for (const p of winCandidates) {
      if (existsSync(p)) return p;
    }
    try {
      const out = execFileSync('where.exe', ['agy'], { encoding: 'utf-8', timeout: 1500 })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (out && existsSync(out)) return out;
    } catch {}
    return null;
  }

  const candidates = [
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    '/usr/bin/agy',
    join(homedir(), '.local', 'bin', 'agy'),
    join(homedir(), '.antigravity', 'bin', 'agy'),
    '/Applications/Antigravity.app/Contents/Resources/app/bin/agy'
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    const out = execFileSync('which', ['agy'], { encoding: 'utf-8', timeout: 1500 }).trim();
    if (out && existsSync(out)) return out;
  } catch {}
  return null;
}

export async function launchCliTerminal(payload = {}) {
  let targetDir = homedir();
  const candidates = [payload.workspacePath];
  if (payload.workspaceUri && String(payload.workspaceUri).startsWith('file://')) {
    try { candidates.unshift(fileURLToPath(payload.workspaceUri)); } catch {}
  }
  for (const c of candidates) {
    if (c && typeof c === 'string') {
      try {
        const resolved = resolve(c);
        if (existsSync(resolved) && statSync(resolved).isDirectory()) {
          targetDir = resolved;
          break;
        }
      } catch {}
    }
  }

  const agyBin = resolveCliBinary();

  if (process.platform === 'darwin') {
    const script = [
      'on run argv',
      '  set targetDir to item 1 of argv',
      '  set agyBin to item 2 of argv',
      '  if agyBin is not "" then',
      '    set shellCmd to "cd " & quoted form of targetDir & " && clear && " & quoted form of agyBin',
      '  else',
      '    set shellCmd to "cd " & quoted form of targetDir & " && clear && echo " & quoted form of "已进入当前工作区目录；当前系统尚未安装 agy CLI 命令。"',
      '  end if',
      '  tell application "Terminal"',
      '    activate',
      '    do script shellCmd',
      '  end tell',
      'end run'
    ].join('\n');

    return new Promise((resolvePromise) => {
      execFile('/usr/bin/osascript', ['-e', script, targetDir, agyBin || ''], { timeout: 6000 }, (err) => {
        if (err) {
          resolvePromise({ ok: false, error: `打开终端失败：${err.message}` });
        } else {
          resolvePromise({
            ok: true,
            agyInstalled: Boolean(agyBin),
            workspacePath: targetDir,
            message: agyBin
              ? `已在 Terminal 启动 agy CLI（${basename(targetDir)}）`
              : `已在 Terminal 打开工作区 ${basename(targetDir)}（本机暂未安装 agy CLI）`
          });
        }
      });
    });
  }

  if (process.platform === 'win32') {
    return new Promise((resolvePromise) => {
      const innerCmd = agyBin ? `"${agyBin}"` : 'echo 当前系统尚未安装 agy CLI 命令。';
      execFile('cmd.exe', ['/c', 'start', 'Antigravity CLI', '/D', targetDir, 'cmd.exe', '/k', innerCmd], { timeout: 6000 }, (err) => {
        if (err) {
          resolvePromise({ ok: false, error: `打开终端失败：${err.message}` });
        } else {
          resolvePromise({
            ok: true,
            agyInstalled: Boolean(agyBin),
            workspacePath: targetDir,
            message: agyBin
              ? `已在终端启动 agy CLI（${basename(targetDir)}）`
              : `已在终端打开工作区 ${basename(targetDir)}（本机暂未安装 agy CLI）`
          });
        }
      });
    });
  }

  if (process.platform === 'linux') {
    const terms = [
      ['x-terminal-emulator', ['--working-directory', targetDir, '-e', agyBin || 'bash']],
      ['gnome-terminal', ['--working-directory', targetDir, '--', agyBin || 'bash']],
      ['konsole', ['--workdir', targetDir, '-e', agyBin || 'bash']],
      ['xfce4-terminal', ['--working-directory', targetDir, '-e', agyBin || 'bash']]
    ];
    for (const [bin, args] of terms) {
      try {
        const found = execFileSync('which', [bin], { encoding: 'utf-8', timeout: 1000 }).trim();
        if (found) {
          execFile(found, args, { cwd: targetDir });
          return {
            ok: true,
            agyInstalled: Boolean(agyBin),
            workspacePath: targetDir,
            message: agyBin
              ? `已在终端启动 agy CLI（${basename(targetDir)}）`
              : `已在终端打开工作区 ${basename(targetDir)}（本机暂未安装 agy CLI）`
          };
        }
      } catch {}
    }
  }

  return {
    ok: false,
    error: '当前环境未检测到可用桌面终端模拟器，请直接在终端运行 agy。'
  };
}
