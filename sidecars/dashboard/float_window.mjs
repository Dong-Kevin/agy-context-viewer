#!/usr/bin/env node
/**
 * Persistent Menu Bar (`NSStatusItem`) & Right-Side Floating Window Controller (`float_window.mjs`).
 *
 * - macOS: Compiles & caches `native_float_macos.swift` once into sidecar state dir,
 *   hosting:
 *     1) Top-right macOS Menu Bar live context indicator (`◈ 42%`), 1-click to pop/hide
 *        the right-side dashboard window (`<5ms` zero cold-start), switchable ON/OFF anytime;
 *     2) Native Cocoa + WKWebView right-docked Always-on-Top (`📌`) floating window
 *        communicating strictly over zero-port stdin/stdout JSON lines.
 * - Windows / Linux (or macOS without swiftc): Cleanly falls back to a frameless
 *   Chromium `--app` mini-window backed by a local loopback server.
 */

import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  collectTokenHistory,
  getMenubarMode,
  getMenubarPreference,
  getPluginStateDir,
  getSettings,
  getSidebarEntryStatus,
  launchCliTerminal,
  MENUBAR_MODES,
  saveSettings,
  scanConversation,
  setMenubarMode,
  setMenubarPreference,
  setSidebarEntrypoint,
  updateActiveSessionHint
} from './collector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_VERSION = 4;

const MENUBAR_MODE_LABELS = {
  context: '当前上下文使用占比',
  speed: '最新生成速度与耗时（均值 / 峰值）',
  quota: '5 小时 / Week 额度余量'
};

function getStateFilePath() {
  return join(getPluginStateDir(), 'float_window_state.json');
}

function getCmdFilePath() {
  return join(getPluginStateDir(), 'float_cmd.json');
}

function getSpawnLockPath() {
  return join(getPluginStateDir(), 'float_spawn.lock');
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function writeJsonFileAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

function readFloatState() {
  const p = getStateFilePath();
  if (!existsSync(p)) return null;
  try {
    const obj = JSON.parse(readFileSync(p, 'utf-8'));
    if (obj?.pid && isPidAlive(obj.pid)) return obj;
  } catch {}
  try { rmSync(p, { force: true }); } catch {}
  return null;
}

function writeFloatState(data) {
  writeJsonFileAtomic(getStateFilePath(), data);
}

function clearFloatStateIfOwned() {
  const p = getStateFilePath();
  if (!existsSync(p)) return;
  try {
    const obj = JSON.parse(readFileSync(p, 'utf-8'));
    if (!obj?.pid || obj.pid === process.pid) {
      rmSync(p, { force: true });
    }
  } catch {
    try { rmSync(p, { force: true }); } catch {}
  }
}

async function terminateProcessAndWait(pid, timeoutMs = 900) {
  if (!pid || !isPidAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 35));
  }
  if (isPidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  try { rmSync(getStateFilePath(), { force: true }); } catch {}
}

export function getFloatWindowStatus() {
  const st = readFloatState();
  const menubarSupported = process.platform === 'darwin';
  const prefMenubar = menubarSupported ? getMenubarPreference() : false;
  const prefMode = getMenubarMode();
  if (!st) {
    return {
      ok: true,
      daemonRunning: false,
      running: false,
      windowVisible: false,
      pinned: false,
      menubarEnabled: prefMenubar,
      menubarMode: prefMode,
      menubarActive: false,
      menubarSupported,
      statusTitle: null,
      activeConvId: null,
      activeConvTitle: null,
      mode: null
    };
  }
  const windowVisible = st.windowVisible !== undefined ? Boolean(st.windowVisible) : Boolean(st.running);
  return {
    ok: true,
    daemonRunning: true,
    running: windowVisible,
    windowVisible,
    pid: st.pid,
    pinned: Boolean(st.pinned),
    menubarEnabled: menubarSupported ? Boolean(st.menubarEnabled ?? prefMenubar) : false,
    menubarMode: MENUBAR_MODES.includes(st.menubarMode) ? st.menubarMode : prefMode,
    menubarActive: Boolean(st.menubarEnabled),
    menubarSupported,
    statusTitle: st.statusTitle || null,
    activeConvId: st.activeConvId || null,
    activeConvTitle: st.activeConvTitle || null,
    hasLsBridge: Boolean(st.hasLsBridge),
    mode: st.mode || 'native-macos',
    cmdSeq: Number(st.cmdSeq || 0),
    startedAt: st.startedAt || null
  };
}

async function sendDaemonCommand(current, cmdObj) {
  const seq = Math.max(Number(current.cmdSeq || 0) + 1, Date.now());
  writeJsonFileAtomic(getCmdFilePath(), { seq, ...cmdObj });
  try {
    process.kill(current.pid, 'SIGUSR1');
  } catch {
    return getFloatWindowStatus();
  }

  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    const st = readFloatState();
    if (!st || Number(st.cmdSeq || 0) >= seq) {
      return getFloatWindowStatus();
    }
  }
  return getFloatWindowStatus();
}

function resolveStandaloneNodeBinary() {
  if (process.execPath && !/Antigravity|Electron|Helper/i.test(process.execPath) && existsSync(process.execPath)) {
    return { bin: process.execPath, extraEnv: {} };
  }
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node'
  ];
  for (const c of candidates) {
    if (existsSync(c)) return { bin: c, extraEnv: {} };
  }
  if (process.platform !== 'win32') {
    try {
      const found = execFileSync('/usr/bin/which', ['node'], { encoding: 'utf-8', timeout: 1000 }).trim();
      if (found && existsSync(found)) return { bin: found, extraEnv: {} };
    } catch {}
  }
  return { bin: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
}

async function spawnDaemon({ pinned = true, menubarEnabled = true, hiddenWindow = false, menubarMode = '' } = {}) {
  const lockPath = getSpawnLockPath();
  if (existsSync(lockPath)) {
    try {
      const lockAge = Date.now() - statSync(lockPath).mtimeMs;
      const lockObj = JSON.parse(readFileSync(lockPath, 'utf-8'));
      if (lockAge < 15000 && lockObj?.pid && isPidAlive(lockObj.pid)) {
        const waitDeadline = Date.now() + 15000;
        while (Date.now() < waitDeadline) {
          await new Promise((r) => setTimeout(r, 80));
          const existing = readFloatState();
          if (existing?.daemonVersion === DAEMON_VERSION) {
            return getFloatWindowStatus();
          }
          if (!existsSync(lockPath)) break;
        }
      }
    } catch {}
  }

  try {
    writeJsonFileAtomic(lockPath, { pid: process.pid, at: Date.now() });
  } catch {}

  try {
    const resolvedMode = MENUBAR_MODES.includes(menubarMode) ? menubarMode : getMenubarMode();
    const daemonArgs = [fileURLToPath(import.meta.url), '--daemon', '--mode', resolvedMode];
    if (pinned === false) daemonArgs.push('--unpinned');
    if (!menubarEnabled) daemonArgs.push('--no-menubar');
    if (hiddenWindow) daemonArgs.push('--hidden-window');

    const { bin: nodeBin, extraEnv } = resolveStandaloneNodeBinary();
    const child = spawn(nodeBin, daemonArgs, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...extraEnv }
    });
    child.unref();

    // Covers one-time cold-cache swiftc compilation (~2s); cached binary boots in ~80ms
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 65));
      const st = readFloatState();
      if (st?.pid && st?.daemonVersion === DAEMON_VERSION) {
        return getFloatWindowStatus();
      }
    }
  } finally {
    try { rmSync(lockPath, { force: true }); } catch {}
  }

  return null;
}

export async function controlFloatWindow(options = {}) {
  const action = String(options.action || 'toggle').toLowerCase();
  if (action === 'status') {
    return getFloatWindowStatus();
  }

  let current = readFloatState();
  const callerLsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || '';

  // Seamlessly upgrade older daemons OR refresh daemon when Antigravity restarts with a new LS port
  if (
    current &&
    action !== 'quit' &&
    (current.daemonVersion !== DAEMON_VERSION || (callerLsAddr && current.lsAddress !== callerLsAddr))
  ) {
    const prevVisible = Boolean(current.windowVisible ?? current.running);
    const prevPinned = current.pinned !== false;
    await terminateProcessAndWait(current.pid);
    current = null;
    if (action === 'ensure-menubar' && prevVisible) {
      const restarted = await spawnDaemon({
        pinned: prevPinned,
        menubarEnabled: process.platform === 'darwin' ? getMenubarPreference() : false,
        hiddenWindow: false,
        menubarMode: getMenubarMode()
      });
      return restarted || getFloatWindowStatus();
    }
  }

  if (action === 'quit') {
    if (current?.pid) {
      await terminateProcessAndWait(current.pid);
    }
    return {
      ...getFloatWindowStatus(),
      closed: true,
      message: '已彻底退出悬浮看板与顶部菜单栏守护进程'
    };
  }

  if (action === 'refresh-session') {
    if (current?.menubarEnabled) {
      return sendDaemonCommand(current, { cmd: 'refreshSession' });
    }
    return getFloatWindowStatus();
  }

  if (action === 'ensure-menubar') {
    if (process.platform !== 'darwin' || !getMenubarPreference()) {
      return getFloatWindowStatus();
    }
    if (current) {
      if (!current.menubarEnabled) {
        return sendDaemonCommand(current, { cmd: 'setMenubar', enabled: true, mode: getMenubarMode() });
      }
      return getFloatWindowStatus();
    }
    const st = await spawnDaemon({
      pinned: true,
      menubarEnabled: true,
      hiddenWindow: true,
      menubarMode: getMenubarMode()
    });
    return st || getFloatWindowStatus();
  }

  if (action === 'set-menubar-mode') {
    if (process.platform !== 'darwin') {
      return {
        ...getFloatWindowStatus(),
        ok: false,
        error: '顶部系统菜单栏常驻图标仅支持 macOS 系统'
      };
    }
    const validMode = setMenubarMode(options.menubarMode);
    if (!getMenubarPreference()) {
      setMenubarPreference(true);
    }
    let nextStatus;
    if (current) {
      nextStatus = await sendDaemonCommand(current, {
        cmd: 'setMenubarMode',
        mode: validMode,
        enableMenubar: true
      });
    } else {
      nextStatus = await spawnDaemon({
        pinned: true,
        menubarEnabled: true,
        hiddenWindow: true,
        menubarMode: validMode
      });
    }
    const fresh = getFloatWindowStatus();
    return {
      ...(nextStatus || fresh),
      ...fresh,
      ok: true,
      menubarEnabled: true,
      menubarMode: validMode,
      message: `顶部菜单栏已切换为「${MENUBAR_MODE_LABELS[validMode] || validMode}」${fresh.statusTitle ? `（当前显示：${fresh.statusTitle}）` : ''}`
    };
  }

  if (action === 'set-menubar') {
    if (process.platform !== 'darwin') {
      return {
        ...getFloatWindowStatus(),
        ok: false,
        error: '顶部系统菜单栏常驻图标仅支持 macOS 系统（当前平台可使用 📌 独立悬浮小窗）'
      };
    }
    const curPref = getMenubarPreference();
    const wantEnabled = typeof options.menubarEnabled === 'boolean'
      ? options.menubarEnabled
      : !curPref;
    setMenubarPreference(wantEnabled);
    const curMode = options.menubarMode ? setMenubarMode(options.menubarMode) : getMenubarMode();

    let nextStatus;
    if (current) {
      nextStatus = await sendDaemonCommand(current, { cmd: 'setMenubar', enabled: wantEnabled, mode: curMode });
    } else if (wantEnabled) {
      nextStatus = await spawnDaemon({
        pinned: true,
        menubarEnabled: true,
        hiddenWindow: true,
        menubarMode: curMode
      });
    } else {
      nextStatus = getFloatWindowStatus();
    }

    const fresh = getFloatWindowStatus();
    return {
      ...(nextStatus || fresh),
      ...fresh,
      ok: true,
      menubarEnabled: wantEnabled,
      menubarMode: curMode,
      message: wantEnabled
        ? `已开启顶部菜单栏常驻图标（${MENUBAR_MODE_LABELS[curMode]}${fresh.statusTitle ? `：${fresh.statusTitle}` : ''}），单击可秒开或收回看板`
        : '已关闭顶部菜单栏常驻图标（仍可随时使用 📌 右侧置顶小窗）'
    };
  }

  const curVisible = Boolean(current?.windowVisible ?? current?.running);
  const shouldClose = action === 'close' || (action === 'toggle' && curVisible);

  if (shouldClose) {
    if (!current) {
      return {
        ...getFloatWindowStatus(),
        closed: true,
        message: '右侧独立看板当前已处于关闭状态'
      };
    }
    if (current.menubarEnabled && current.mode === 'native-macos') {
      const st = await sendDaemonCommand(current, { cmd: 'hideWindow' });
      return {
        ...st,
        closed: true,
        message: '已收回右侧小窗（顶部菜单栏 ◈ 图标仍常驻，单击可随时秒开）'
      };
    }
    await terminateProcessAndWait(current.pid);
    return {
      ...getFloatWindowStatus(),
      closed: true,
      message: '已关闭右侧独立置顶看板'
    };
  }

  // Open or focus window
  if (current) {
    const cmdPayload = { cmd: 'showWindow' };
    if (typeof options.pinned === 'boolean') {
      cmdPayload.pinned = options.pinned;
    }
    const st = await sendDaemonCommand(current, cmdPayload);
    return {
      ...st,
      alreadyRunning: curVisible,
      message: st.pinned
        ? '已在屏幕右侧弹出独立置顶看板（点击右上角 ◈ 菜单栏图标或 📌 可随时收回）'
        : '已在屏幕右侧打开独立看板小窗'
    };
  }

  const wantMenubar = process.platform === 'darwin' ? getMenubarPreference() : false;
  const st = await spawnDaemon({
    pinned: options.pinned !== false,
    menubarEnabled: wantMenubar,
    hiddenWindow: false,
    menubarMode: getMenubarMode()
  });

  if (st) {
    return {
      ...st,
      message: st.pinned
        ? '已在屏幕右侧钉住独立看板（右上角菜单栏 ◈ 实时水位同步就绪，单击可随时显隐）'
        : '已在屏幕右侧打开独立看板小窗'
    };
  }

  return {
    ok: false,
    running: false,
    error: '启动独立悬浮窗口超时，请检查系统环境或重试。'
  };
}

// ---------------------------------------------------------------------------
// Daemon Implementation (Native macOS Menu Bar + WKWebView IPC + Fallback)
// ---------------------------------------------------------------------------

function buildBundledFloatHtml({ initialPinned, initialHidden, initialMenubar, initialMode = 'context' }) {
  let html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
  const css = readFileSync(join(__dirname, 'styles.css'), 'utf-8').replace(/<\/style/gi, '<\\/style');
  const js = readFileSync(join(__dirname, 'app.js'), 'utf-8').replace(/<\/script/gi, '<\\/script');

  // Remove external preload & Google Fonts links so WKWebView runs 100% offline in-memory
  html = html.replace(/<script\s+src="\/preload\.js"><\/script>/i, '');
  html = html.replace(/<link[^>]+fonts\.googleapis\.com[^>]*>/gi, '');
  html = html.replace(/<link[^>]+fonts\.gstatic\.com[^>]*>/gi, '');
  html = html.replace(
    /<link\s+rel="stylesheet"\s+href="\/styles\.css[^"]*">/i,
    () => `<style id="cv-inline-styles">\n${css}\n</style>`
  );

  const bridgeScript = `
<script>
(() => {
  window.__CV_FLOAT_MODE__ = true;
  window.__CV_FLOAT_PINNED__ = ${initialPinned ? 'true' : 'false'};
  window.__CV_INITIAL_HIDDEN__ = ${initialHidden ? 'true' : 'false'};
  window.__CV_MENUBAR_ENABLED__ = ${initialMenubar ? 'true' : 'false'};
  window.__CV_MENUBAR_MODE__ = ${JSON.stringify(initialMode || 'context')};
  let seq = 1;
  const pending = new Map();

  window.__cvResolveRpc = (id, status, payload) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    item.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    });
  };

  window.sidecar = {
    conversationId: "",
    isFloatWindow: true,
    getWorkspaceUris: async () => [],
    onWorkspaceChange: () => () => {},
    setPinned: (pinned) => {
      window.__CV_FLOAT_PINNED__ = Boolean(pinned);
      window.webkit?.messageHandlers?.cvBridge?.postMessage(
        JSON.stringify({ kind: "togglePin", pinned: Boolean(pinned) })
      );
    },
    closeFloatWindow: () => {
      window.webkit?.messageHandlers?.cvBridge?.postMessage(
        JSON.stringify({ kind: "closeWindow" })
      );
    },
    fetch: (path, opts = {}) => new Promise((resolve, reject) => {
      const id = seq++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("IPC request timeout"));
        }
      }, 15000);
      pending.set(id, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
      window.webkit.messageHandlers.cvBridge.postMessage(JSON.stringify({
        kind: "rpc",
        id,
        path: String(path || ""),
        method: String(opts.method || "GET").toUpperCase(),
        body: opts.body || null
      }));
    })
  };
})();
</script>`;

  html = html.replace(
    /<script\s+src="\/app\.js[^"]*"><\/script>/i,
    () => `${bridgeScript}\n<script>\n${js}\n</script>`
  );
  return html;
}

function fmtCompactTok(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

function fmtCompactDur(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return null;
  const s = Number(sec);
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = Math.round(s - m * 60);
    return rem > 0 ? `${m}m${rem}s` : `${m}m`;
  }
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}

function fmtCompactTps(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

function fmtQuotaWindowAndCountdown(resetTime) {
  if (!resetTime) return { winTag: '额度', countdown: '' };
  const ms = new Date(resetTime).getTime() - Date.now();
  if (!Number.isFinite(ms)) return { winTag: '额度', countdown: '' };
  const winTag = ms > 24 * 3600 * 1000 ? 'Week' : '5h';
  if (ms <= 0) return { winTag, countdown: '即将重置' };
  const totalMin = Math.max(1, Math.round(ms / 60000));
  if (ms > 24 * 3600 * 1000) {
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    return { winTag, countdown: h > 0 ? `${d}d${h}h` : `${d}d` };
  }
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return { winTag, countdown: `${h}h${String(m).padStart(2, '0')}m` };
  }
  return { winTag, countdown: `${totalMin}m` };
}

function truncateDisplayCols(str, maxCols = 24) {
  const s = String(str || '').trim();
  let cols = 0;
  for (const ch of s) {
    cols += (ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1;
  }
  if (cols <= maxCols) return s;
  let out = '';
  let cur = 0;
  for (const ch of s) {
    const w = (ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1;
    if (cur + w > maxCols - 1) break;
    out += ch;
    cur += w;
  }
  return `${out.trimEnd()}…`;
}

function cleanTooltipConvTitle(rawTitle, fallbackId = '') {
  const base = String(rawTitle || '').trim();
  if (!base) return fallbackId ? `会话 ${fallbackId.slice(0, 8)}` : '当前对话';
  const shortened = base
    .replace(/https?:\/\/(?:www\.)?[^/\s]+\/([^\s]+)/gi, (_, tail) => {
      const segs = tail.split('/').filter(Boolean);
      return segs.length ? segs[segs.length - 1] : '';
    })
    .replace(/https?:\/\/[^\s]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateDisplayCols(shortened || base, 24);
}

function cleanTooltipModel(rawModel) {
  const s = String(rawModel || '').trim();
  if (!s) return '待首轮请求';
  return truncateDisplayCols(
    s.replace(/\s*\(([^()]+)\)\s*$/, ' · $1').replace(/\s+/g, ' '),
    28
  );
}

function summarizePoolShortLabel(pool) {
  const fams = Array.isArray(pool?.families) ? pool.families.filter(Boolean) : [];
  if (fams.length === 1 && fams[0].length <= 15) {
    return fams[0];
  }
  const brands = [];
  for (const f of fams) {
    let b = String(f).trim();
    if (/^gemini\b/i.test(b)) b = 'Gemini';
    else if (/^claude\b/i.test(b)) b = 'Claude';
    else if (/^gpt\b/i.test(b)) b = 'GPT';
    else b = b.split(/[\s/-]+/)[0] || b;
    if (b && !brands.includes(b)) brands.push(b);
  }
  if (brands.length === 1) return `${brands[0]} 系列`;
  if (brands.length >= 2) return brands.slice(0, 2).join(' / ');
  const fallback = String(pool?.title || '配额池').replace(/\s*配额池$/, '').trim();
  return truncateDisplayCols(fallback || '配额池', 14);
}

export function formatStatusItemFromSnapshot(snap, rawMode = 'context') {
  const mode = MENUBAR_MODES.includes(rawMode) ? rawMode : 'context';
  const cx = snap?.context;
  const spd = snap?.speed;
  const hasConv = Boolean(snap?.ok && snap.conversationId);

  let title = mode === 'speed' ? '⚡ --t/s' : mode === 'quota' ? '⏳ 额度 --%' : '◈ --%';

  if (mode === 'context') {
    if (hasConv && cx) {
      if (cx.percent !== null && cx.percent !== undefined) {
        const pct = Math.max(0, Math.min(999, Math.round(Number(cx.percent || 0))));
        const prefix = pct >= 90 ? '⚠ ' : '◈ ';
        title = `${prefix}${pct}%`;
      } else {
        title = '◈ 0%';
      }
    }
  } else if (mode === 'speed') {
    const latestTps = fmtCompactTps(spd?.tps ?? spd?.streamingTps ?? null);
    const durStr = fmtCompactDur(spd?.duration);
    const avgStr = fmtCompactTps(spd?.avgTps);
    const peakStr = fmtCompactTps(spd?.peakTps);
    if (hasConv && latestTps !== null) {
      const mainPart = durStr ? `${latestTps}t/s·${durStr}` : `${latestTps}t/s`;
      const subPart = (avgStr !== null && peakStr !== null) ? ` (均${avgStr}/峰${peakStr})` : '';
      title = `⚡ ${mainPart}${subPart}`;
    } else if (hasConv && durStr !== null) {
      title = `⚡ ${durStr}`;
    }
  } else if (mode === 'quota') {
    const q = cx?.quota || (Array.isArray(snap?.quotas) && snap.quotas.length ? snap.quotas[0] : null);
    if (q && q.weekly && typeof q.weekly.remainingPercent === 'number' && typeof q.remainingPercent === 'number') {
      const p5 = Math.max(0, Math.min(100, Math.round(q.remainingPercent)));
      const pW = Math.max(0, Math.min(100, Math.round(q.weekly.remainingPercent)));
      const icon = Math.min(p5, pW) <= 15 ? '⚠ ' : '⏳ ';
      title = `${icon}5h ${p5}%·周${pW}%`;
    } else if (q && typeof q.remainingPercent === 'number') {
      const remPct = Math.max(0, Math.min(100, Math.round(q.remainingPercent)));
      const { winTag, countdown } = fmtQuotaWindowAndCountdown(q.resetTime);
      const icon = remPct <= 15 ? '⚠ ' : '⏳ ';
      title = countdown ? `${icon}${winTag} ${remPct}%·${countdown}` : `${icon}${winTag} ${remPct}%`;
    }
  }

  // Structured multi-block tooltip: every line stays <= 36 display cols to avoid awkward wrapping
  const sections = [];

  if (hasConv) {
    const convShort = cleanTooltipConvTitle(snap.conversationTitle, snap.conversationId);
    const modelShort = cleanTooltipModel(cx?.model);
    sections.push([`会话：${convShort}`, `模型：${modelShort}`].join('\n'));

    const metricLines = [];
    if (cx && cx.percent !== null && cx.percent !== undefined) {
      const limNum = Number(cx.budget || 256000);
      const limStr = limNum >= 1_000_000 ? `${(limNum / 1_000_000).toFixed(0)}M` : `${Math.round(limNum / 1_000)}K`;
      metricLines.push(`上下文：${Math.round(Number(cx.percent))}%（${fmtCompactTok(cx.used)} / ${limStr}）`);
    } else {
      metricLines.push('上下文：0%（新会话待首轮请求）');
    }

    if (spd && (spd.tps != null || spd.duration != null)) {
      const dLbl = fmtCompactDur(spd.duration) || '--';
      metricLines.push(`速度：${spd.tps ?? '--'} tok/s · 耗时 ${dLbl}`);
      if (spd.avgTps != null || spd.peakTps != null) {
        metricLines.push(`统计：均值 ${spd.avgTps ?? '--'} · 峰值 ${spd.peakTps ?? '--'} tok/s`);
      }
    }
    sections.push(metricLines.join('\n'));
  } else {
    sections.push('上下文与 Token 看板');
  }

  const quotaLines = [];
  const pools = Array.isArray(snap?.quotas) ? snap.quotas : [];
  if (pools.length) {
    for (const pool of pools.slice(0, 3)) {
      const poolName = summarizePoolShortLabel(pool);
      if (pool.fiveHour && pool.weekly) {
        quotaLines.push(`${poolName}：5h ${pool.fiveHour.remainingPercent}% · 周 ${pool.weekly.remainingPercent}%`);
      } else if (typeof pool.remainingPercent === 'number') {
        const { winTag, countdown } = fmtQuotaWindowAndCountdown(pool.resetTime);
        const rst = countdown ? ` · ${countdown} 重置` : '';
        quotaLines.push(`${poolName} (${winTag})：${pool.remainingPercent}%${rst}`);
      }
    }
  } else if (cx?.quota && typeof cx.quota.remainingPercent === 'number') {
    const qName = truncateDisplayCols(cx.quota.label || '当前配额', 14);
    if (cx.quota.weekly && typeof cx.quota.weekly.remainingPercent === 'number') {
      quotaLines.push(`${qName}：5h ${cx.quota.remainingPercent}% · 周 ${cx.quota.weekly.remainingPercent}%`);
    } else {
      const { winTag, countdown } = fmtQuotaWindowAndCountdown(cx.quota.resetTime);
      quotaLines.push(`${qName} (${winTag})：${cx.quota.remainingPercent}%${countdown ? ` · ${countdown} 重置` : ''}`);
    }
  }
  if (quotaLines.length) {
    sections.push(quotaLines.join('\n'));
  }

  sections.push('左键显隐看板 · 右键切换模式与置顶');
  return { title, tooltip: sections.join('\n\n') };
}

async function dispatchApiRpc(rawPath, method, rawBody, currentState, hooks = {}) {
  const u = new URL(rawPath, 'http://127.0.0.1');
  const data = Object.fromEntries(u.searchParams.entries());
  if (rawBody && method === 'POST') {
    try {
      Object.assign(data, typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody);
    } catch {}
  }

  if (u.pathname === '/api/context' && method === 'GET') {
    const convId = data.conversationId || '';
    const force = data.force === '1' || data.force === 'true' || data.force === true;
    const snap = await scanConversation(convId, { force });
    if (hooks.onActiveContextSnap && (!convId || convId === currentState.pinnedConvId)) {
      hooks.onActiveContextSnap(snap);
    }
    if (!force && data.etag && snap.etag && data.etag === snap.etag) {
      return {
        ok: true,
        unchanged: true,
        etag: snap.etag,
        conversationId: snap.conversationId,
        recentConversations: snap.recentConversations
      };
    }
    return snap;
  }

  if (u.pathname === '/api/history' && method === 'GET') {
    const force = data.force === '1' || data.force === 'true' || data.force === true;
    const hist = await collectTokenHistory({ force });
    if (!force && data.etag && hist.etag && data.etag === hist.etag) {
      return { ok: true, unchanged: true, etag: hist.etag };
    }
    return hist;
  }

  if (u.pathname === '/api/settings' && method === 'GET') {
    return getSettings();
  }
  if (u.pathname === '/api/settings' && method === 'POST') {
    return saveSettings(data);
  }
  if (u.pathname === '/api/launch-cli' && method === 'POST') {
    return launchCliTerminal(data);
  }
  if (u.pathname === '/api/float-window') {
    return {
      ok: true,
      daemonRunning: true,
      running: Boolean(currentState.windowVisible),
      windowVisible: Boolean(currentState.windowVisible),
      pinned: Boolean(currentState.pinned),
      menubarEnabled: Boolean(currentState.menubarEnabled),
      menubarMode: currentState.menubarMode || getMenubarMode(),
      mode: currentState.mode
    };
  }
  if (u.pathname === '/api/entrypoints' && method === 'GET') {
    return {
      ...getSidebarEntryStatus(),
      menubarEnabled: Boolean(currentState.menubarEnabled),
      menubarMode: currentState.menubarMode || getMenubarMode(),
      menubarSupported: process.platform === 'darwin',
      floatWindow: {
        ok: true,
        daemonRunning: true,
        running: Boolean(currentState.windowVisible),
        windowVisible: Boolean(currentState.windowVisible),
        pinned: Boolean(currentState.pinned),
        menubarEnabled: Boolean(currentState.menubarEnabled),
        menubarMode: currentState.menubarMode || getMenubarMode(),
        mode: currentState.mode
      }
    };
  }
  if (u.pathname === '/api/entrypoints' && method === 'POST') {
    const hasSessionHint = typeof data.pinnedConvId === 'string' || typeof data.activeHostConvId === 'string';
    if (hasSessionHint) {
      updateActiveSessionHint({
        pinnedConvId: typeof data.pinnedConvId === 'string' ? data.pinnedConvId : undefined,
        userFocusedConvId: typeof data.activeHostConvId === 'string' ? data.activeHostConvId : undefined,
        userFocusedAt: data.activeHostConvId ? Date.now() : undefined
      });
      if (typeof data.pinnedConvId === 'string') {
        currentState.pinnedConvId = data.pinnedConvId;
      }
      hooks.onRefreshMenubar?.();
      if (
        typeof data.menubarEnabled !== 'boolean' &&
        typeof data.menubarMode !== 'string' &&
        typeof data.sidebarEnabled !== 'boolean' &&
        !data.target
      ) {
        return {
          ...getSidebarEntryStatus(),
          menubarEnabled: Boolean(currentState.menubarEnabled),
          menubarMode: currentState.menubarMode || getMenubarMode(),
          menubarSupported: process.platform === 'darwin'
        };
      }
    }
    if (typeof data.menubarMode === 'string' && hooks.onSetMenubarMode) {
      return hooks.onSetMenubarMode(data.menubarMode);
    }
    if (typeof data.menubarEnabled === 'boolean' && hooks.onSetMenubar) {
      return hooks.onSetMenubar(Boolean(data.menubarEnabled));
    }
    if (typeof data.sidebarEnabled === 'boolean') {
      return setSidebarEntrypoint(data.sidebarEnabled);
    }
    if (hooks.onSetMenubar) {
      return hooks.onSetMenubar(!currentState.menubarEnabled);
    }
    return getSidebarEntryStatus();
  }

  throw new Error(`Unknown route: ${method} ${u.pathname}`);
}

function ensureCompiledMacBinary() {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/swiftc')) {
    return null;
  }
  const swiftSrc = join(__dirname, 'native_float_macos.swift');
  if (!existsSync(swiftSrc)) return null;

  const srcHash = createHash('sha256').update(readFileSync(swiftSrc)).digest('hex').slice(0, 10);
  const binDir = join(getPluginStateDir(), 'bin');
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, `cv-float-macos-${srcHash}`);

  if (existsSync(binPath)) {
    return binPath;
  }

  try {
    execFileSync('/usr/bin/swiftc', [swiftSrc, '-o', binPath], {
      stdio: 'pipe',
      timeout: 30000
    });
    return binPath;
  } catch {
    return null;
  }
}

async function startMacNativeDaemon({ initialPinned, initialMenubar, initialVisible, initialMode = 'context' }) {
  const binPath = ensureCompiledMacBinary();
  if (!binPath) {
    if (!initialVisible) {
      process.exit(0);
    }
    return startFallbackAppWindowDaemon();
  }

  const resolvedMode = MENUBAR_MODES.includes(initialMode) ? initialMode : getMenubarMode();
  const state = {
    daemonVersion: DAEMON_VERSION,
    daemonRunning: true,
    running: initialVisible,
    windowVisible: initialVisible,
    pid: process.pid,
    pinned: initialPinned,
    menubarEnabled: initialMenubar,
    menubarMode: resolvedMode,
    statusTitle: resolvedMode === 'speed' ? '⚡ --t/s' : resolvedMode === 'quota' ? '⏳ 额度 --%' : '◈ --%',
    activeConvId: null,
    activeConvTitle: null,
    hasLsBridge: Boolean(process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN),
    lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS || '',
    mode: 'native-macos',
    cmdSeq: 0,
    startedAt: new Date().toISOString()
  };

  const args = ['--mode', resolvedMode];
  if (!initialPinned) args.push('--unpinned');
  if (!initialMenubar) args.push('--no-menubar');
  if (!initialVisible) args.push('--hidden-window');

  const child = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });

  const sendToChild = (obj) => {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    }
  };

  let lastSentTitle = '';
  let lastSentTip = '';
  let lastSentMode = '';
  let latestSnap = null;
  let barPolling = false;

  const applySnapToMenubar = (snap) => {
    if (snap?.ok) {
      latestSnap = snap;
      state.activeConvId = snap.conversationId || null;
      state.activeConvTitle = snap.conversationTitle || null;
    }
    if (!state.menubarEnabled) return;
    const curMode = state.menubarMode || 'context';
    const { title, tooltip } = formatStatusItemFromSnapshot(snap, curMode);
    if (title !== lastSentTitle || tooltip !== lastSentTip || curMode !== lastSentMode) {
      lastSentTitle = title;
      lastSentTip = tooltip;
      lastSentMode = curMode;
      state.statusTitle = title;
      sendToChild({ type: 'updateStatusItem', mode: curMode, title, tooltip });
      writeFloatState(state);
    }
  };

  const refreshMenubarStatusItem = async (forceScan = false) => {
    if (!state.menubarEnabled) return;
    if (barPolling && !forceScan) return;
    barPolling = true;
    try {
      const snap = await scanConversation('', { force: false });
      applySnapToMenubar(snap);
    } catch {} finally {
      barPolling = false;
    }
  };

  const barTimer = setInterval(() => {
    if (state.menubarEnabled) {
      refreshMenubarStatusItem(false).catch(() => {});
    }
  }, 1500);
  barTimer.unref?.();

  const shutdown = () => {
    clearInterval(barTimer);
    clearFloatStateIfOwned();
    sendToChild({ type: 'quit' });
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      process.exit(0);
    }, 120);
  };

  const handleSetMenubarInDaemon = async (wantEnabled) => {
    setMenubarPreference(wantEnabled);
    state.menubarEnabled = wantEnabled;
    if (!wantEnabled) {
      lastSentTitle = '';
      lastSentTip = '';
      lastSentMode = '';
    }
    sendToChild({ type: 'setMenubar', enabled: wantEnabled, mode: state.menubarMode });
    if (wantEnabled) {
      if (latestSnap) applySnapToMenubar(latestSnap);
      await refreshMenubarStatusItem(true);
    }
    writeFloatState(state);
    return {
      ...getSidebarEntryStatus(),
      ok: true,
      menubarEnabled: wantEnabled,
      menubarMode: state.menubarMode,
      menubarSupported: true,
      floatWindow: {
        ok: true,
        daemonRunning: true,
        running: Boolean(state.windowVisible),
        windowVisible: Boolean(state.windowVisible),
        pinned: Boolean(state.pinned),
        menubarEnabled: wantEnabled,
        menubarMode: state.menubarMode,
        statusTitle: state.statusTitle,
        mode: state.mode
      },
      message: wantEnabled
        ? `已开启顶部菜单栏常驻图标（当前显示：${state.statusTitle}）`
        : '已关闭顶部菜单栏常驻图标'
    };
  };

  const handleSetMenubarModeInDaemon = async (rawMode) => {
    const validMode = setMenubarMode(rawMode);
    state.menubarMode = validMode;
    if (!state.menubarEnabled) {
      setMenubarPreference(true);
      state.menubarEnabled = true;
      sendToChild({ type: 'setMenubar', enabled: true, mode: validMode });
    } else {
      sendToChild({ type: 'setMenubarMode', mode: validMode });
    }
    lastSentTitle = '';
    lastSentMode = '';
    if (latestSnap) applySnapToMenubar(latestSnap);
    await refreshMenubarStatusItem(true);
    writeFloatState(state);
    return {
      ...getSidebarEntryStatus(),
      ok: true,
      menubarEnabled: true,
      menubarMode: validMode,
      menubarSupported: true,
      statusTitle: state.statusTitle,
      floatWindow: {
        ok: true,
        daemonRunning: true,
        running: Boolean(state.windowVisible),
        windowVisible: Boolean(state.windowVisible),
        pinned: Boolean(state.pinned),
        menubarEnabled: true,
        menubarMode: validMode,
        statusTitle: state.statusTitle,
        mode: state.mode
      },
      message: `顶部菜单栏已切换为「${MENUBAR_MODE_LABELS[validMode] || validMode}」（当前显示：${state.statusTitle}）`
    };
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('exit', clearFloatStateIfOwned);

  process.on('SIGUSR1', () => {
    (async () => {
      let cmd = { seq: Date.now(), cmd: 'showWindow' };
      const cmdPath = getCmdFilePath();
      if (existsSync(cmdPath)) {
        try {
          cmd = JSON.parse(readFileSync(cmdPath, 'utf-8'));
        } catch {}
      }

      const action = String(cmd.cmd || 'showWindow');
      if (action === 'quit') {
        shutdown();
        return;
      }
      if (action === 'showWindow' || action === 'focus') {
        if (typeof cmd.pinned === 'boolean' && cmd.pinned !== state.pinned) {
          state.pinned = cmd.pinned;
          sendToChild({ type: 'setPinned', pinned: cmd.pinned });
        }
        state.windowVisible = true;
        state.running = true;
        sendToChild({ type: 'showWindow' });
      } else if (action === 'hideWindow') {
        if (state.menubarEnabled) {
          state.windowVisible = false;
          state.running = false;
          sendToChild({ type: 'hideWindow' });
        } else {
          shutdown();
          return;
        }
      } else if (action === 'toggleWindow') {
        if (state.windowVisible) {
          if (state.menubarEnabled) {
            state.windowVisible = false;
            state.running = false;
            sendToChild({ type: 'hideWindow' });
          } else {
            shutdown();
            return;
          }
        } else {
          state.windowVisible = true;
          state.running = true;
          sendToChild({ type: 'showWindow' });
        }
      } else if (action === 'setMenubar') {
        const en = Boolean(cmd.enabled);
        if (cmd.mode && MENUBAR_MODES.includes(cmd.mode)) {
          state.menubarMode = cmd.mode;
        }
        state.menubarEnabled = en;
        if (!en) {
          lastSentTitle = '';
          lastSentTip = '';
          lastSentMode = '';
        }
        if (!en && !state.windowVisible) {
          shutdown();
          return;
        }
        sendToChild({ type: 'setMenubar', enabled: en, mode: state.menubarMode });
        if (en) {
          if (latestSnap) applySnapToMenubar(latestSnap);
          await refreshMenubarStatusItem(true);
        }
      } else if (action === 'setMenubarMode') {
        const validMode = setMenubarMode(cmd.mode);
        state.menubarMode = validMode;
        if (cmd.enableMenubar && !state.menubarEnabled) {
          state.menubarEnabled = true;
          sendToChild({ type: 'setMenubar', enabled: true, mode: validMode });
        } else {
          sendToChild({ type: 'setMenubarMode', mode: validMode });
        }
        lastSentTitle = '';
        lastSentMode = '';
        if (latestSnap) applySnapToMenubar(latestSnap);
        await refreshMenubarStatusItem(true);
      } else if (action === 'refreshSession') {
        await refreshMenubarStatusItem(true);
      } else if (action === 'setPinned' && typeof cmd.pinned === 'boolean') {
        state.pinned = cmd.pinned;
        sendToChild({ type: 'setPinned', pinned: cmd.pinned });
      }

      state.cmdSeq = Number(cmd.seq || Date.now());
      writeFloatState(state);
    })().catch(() => {});
  });

  child.on('exit', () => {
    clearInterval(barTimer);
    clearFloatStateIfOwned();
    process.exit(0);
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.type === 'ready') {
      state.pinned = Boolean(msg.pinned);
      state.menubarEnabled = Boolean(msg.menubarEnabled);
      if (msg.menubarMode && MENUBAR_MODES.includes(msg.menubarMode)) {
        state.menubarMode = msg.menubarMode;
      }
      state.windowVisible = Boolean(msg.windowVisible);
      state.running = state.windowVisible;
      writeFloatState(state);
      sendToChild({
        type: 'loadHtml',
        html: buildBundledFloatHtml({
          initialPinned: state.pinned,
          initialHidden: !state.windowVisible,
          initialMenubar: state.menubarEnabled,
          initialMode: state.menubarMode
        })
      });
      if (state.menubarEnabled) {
        refreshMenubarStatusItem(true).catch(() => {});
      }
    } else if (msg.type === 'menubarModeChanged') {
      const nextMode = setMenubarMode(msg.mode);
      state.menubarMode = nextMode;
      lastSentTitle = '';
      lastSentMode = '';
      if (latestSnap) applySnapToMenubar(latestSnap);
      await refreshMenubarStatusItem(true);
      writeFloatState(state);
    } else if (msg.type === 'visibilityChanged') {
      state.windowVisible = Boolean(msg.windowVisible);
      state.running = state.windowVisible;
      writeFloatState(state);
      if (state.windowVisible && state.menubarEnabled) {
        refreshMenubarStatusItem(true).catch(() => {});
      }
    } else if (msg.type === 'pinChanged') {
      state.pinned = Boolean(msg.pinned);
      writeFloatState(state);
    } else if (msg.type === 'userDisabledMenubar') {
      setMenubarPreference(false);
      state.menubarEnabled = false;
      state.windowVisible = Boolean(msg.windowVisible);
      state.running = state.windowVisible;
      writeFloatState(state);
      if (!state.windowVisible) {
        clearFloatStateIfOwned();
        process.exit(0);
      }
    } else if (msg.type === 'rpcRequest') {
      if (msg.path === '/api/reload-float-bundle') {
        sendToChild({
          type: 'loadHtml',
          html: buildBundledFloatHtml({
            initialPinned: state.pinned,
            initialHidden: !state.windowVisible,
            initialMenubar: state.menubarEnabled,
            initialMode: state.menubarMode
          })
        });
        sendToChild({ type: 'rpcReply', id: msg.id, ok: true, status: 200, payload: { ok: true } });
        return;
      }
      try {
        const payload = await dispatchApiRpc(msg.path, msg.method, msg.body, state, {
          onActiveContextSnap: applySnapToMenubar,
          onSetMenubar: handleSetMenubarInDaemon,
          onSetMenubarMode: handleSetMenubarModeInDaemon,
          onRefreshMenubar: () => { refreshMenubarStatusItem(true).catch(() => {}); }
        });
        sendToChild({ type: 'rpcReply', id: msg.id, ok: true, status: 200, payload });
      } catch (err) {
        sendToChild({
          type: 'rpcReply',
          id: msg.id,
          ok: false,
          status: 500,
          payload: { ok: false, error: err.message }
        });
      }
    } else if (msg.type === 'closed') {
      clearInterval(barTimer);
      clearFloatStateIfOwned();
      process.exit(0);
    }
  });
}

function findChromiumBinary() {
  if (process.platform === 'darwin') {
    const macApps = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    ];
    return macApps.find((p) => existsSync(p)) || null;
  }
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    const winBins = [
      join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      join(local, 'Google\\Chrome\\Application\\chrome.exe')
    ];
    return winBins.find((p) => existsSync(p)) || null;
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    try {
      const out = execFileSync('which', [name], { encoding: 'utf-8', timeout: 1000 }).trim();
      if (out) return out;
    } catch {}
  }
  return null;
}

async function startFallbackAppWindowDaemon() {
  const state = {
    daemonVersion: DAEMON_VERSION,
    daemonRunning: true,
    running: true,
    windowVisible: true,
    pid: process.pid,
    pinned: false,
    menubarEnabled: false,
    mode: 'browser-app',
    cmdSeq: 0,
    startedAt: new Date().toISOString()
  };

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/') {
      const html = readFileSync(join(__dirname, 'index.html'), 'utf-8').replace(
        '<script src="/preload.js"></script>',
        '<script>window.__CV_FLOAT_MODE__ = true; window.__CV_BROWSER_FALLBACK__ = true; window.sidecar = { conversationId: "", fetch: (p, o) => fetch(p, o), getWorkspaceUris: async () => [], onWorkspaceChange: () => () => {}, closeFloatWindow: () => window.close() };</script>'
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && u.pathname === '/styles.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(join(__dirname, 'styles.css'), 'utf-8'));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(join(__dirname, 'app.js'), 'utf-8'));
      return;
    }

    let body = '';
    req.on('data', (c) => { if (body.length < 1024 * 1024) body += c; });
    req.on('end', async () => {
      try {
        if (u.pathname === '/api/float-window' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, running: false }));
          setTimeout(() => { clearFloatStateIfOwned(); process.exit(0); }, 100);
          return;
        }
        const out = await dispatchApiRpc(req.url, req.method, body, state);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
  });

  process.on('SIGTERM', () => { clearFloatStateIfOwned(); process.exit(0); });
  process.on('SIGINT', () => { clearFloatStateIfOwned(); process.exit(0); });
  process.on('exit', clearFloatStateIfOwned);

  server.listen(0, '127.0.0.1', () => {
    const targetUrl = `http://127.0.0.1:${server.address().port}/`;
    state.url = targetUrl;
    writeFloatState(state);

    const browserBin = findChromiumBinary();
    if (browserBin) {
      execFile(browserBin, [`--app=${targetUrl}`, '--window-size=432,860'], () => {});
    } else if (process.platform === 'win32') {
      execFile('cmd.exe', ['/c', 'start', '', targetUrl], () => {});
    } else if (process.platform === 'darwin') {
      execFile('/usr/bin/open', [targetUrl], () => {});
    } else {
      execFile('xdg-open', [targetUrl], () => {});
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--daemon')) {
  const initialPinned = !process.argv.includes('--unpinned');
  const initialMenubar = !process.argv.includes('--no-menubar');
  const initialVisible = !process.argv.includes('--hidden-window');
  const mIdx = process.argv.indexOf('--mode');
  const initialMode = mIdx >= 0 && process.argv[mIdx + 1] ? process.argv[mIdx + 1] : getMenubarMode();
  if (process.platform === 'darwin') {
    startMacNativeDaemon({ initialPinned, initialMenubar, initialVisible, initialMode });
  } else {
    startFallbackAppWindowDaemon();
  }
}
