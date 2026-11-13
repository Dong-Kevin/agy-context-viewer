/**
 * Official Antigravity UI Sidecar Backend for Context & Token Viewer.
 *
 * Uses `sidecar_sdk` (`SidecarApp`, `Response`) when launched by Antigravity,
 * and supports `--standalone` loopback mode for local testing or browser preview.
 */

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, watchFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectTokenHistory,
  createLoopbackSessionToken,
  getMenubarMode,
  getSettings,
  getSidebarEntryStatus,
  guardLoopbackRequest,
  injectCsrfMeta,
  launchCliTerminal,
  LOOPBACK_SECURITY_HEADERS,
  readLoopbackJsonBody,
  saveSettings,
  scanConversation,
  setSidebarEntrypoint,
  updateActiveSessionHint
} from './collector.mjs';
import { controlFloatWindow, getFloatWindowStatus } from './float_window.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8']
};

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store, must-revalidate' };

function createHandlers(getDefaultConvId, makeResponse) {
  return {
    indexHtml: () => makeResponse(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
      contentType: 'text/html; charset=utf-8',
      headers: NO_CACHE_HEADERS
    }),
    staticAsset: (file, contentType) => () =>
      makeResponse(readFileSync(join(__dirname, file), 'utf-8'), {
        contentType,
        headers: NO_CACHE_HEADERS
      }),

    apiContext: async (data = {}) => {
      const convId = data.conversationId || getDefaultConvId() || '';
      const force = data.force === '1' || data.force === 'true' || data.force === true;
      const snap = await scanConversation(convId, { force });
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
    },

    apiHistory: async (data = {}) => {
      const force = data.force === '1' || data.force === 'true' || data.force === true;
      const hist = await collectTokenHistory({ force });
      if (!force && data.etag && hist.etag && data.etag === hist.etag) {
        return { ok: true, unchanged: true, etag: hist.etag };
      }
      return hist;
    },

    apiGetSettings: async () => getSettings(),
    apiSaveSettings: async (data = {}) => saveSettings(data),
    apiLaunchCli: async (data = {}) => launchCliTerminal(data),
    apiFloatStatus: async () => getFloatWindowStatus(),
    apiFloatControl: async (data = {}) => controlFloatWindow(data),
    apiEntrypointsStatus: async () => {
      const fw = getFloatWindowStatus();
      return {
        ...getSidebarEntryStatus(),
        menubarEnabled: fw.menubarEnabled,
        menubarMode: fw.menubarMode || getMenubarMode(),
        menubarActive: fw.menubarActive,
        menubarSupported: fw.menubarSupported,
        shortcut: fw.shortcut,
        shortcutActive: fw.shortcutActive,
        floatWindow: fw
      };
    },
    apiEntrypointsControl: async (data = {}) => {
      const isShortcutUpdate = (
        data.target === 'shortcut' ||
        data.shortcutReset === true ||
        data.reset === true ||
        data.accelerator !== undefined ||
        data.shortcutAccelerator !== undefined ||
        typeof data.shortcutEnabled === 'boolean' ||
        data.shortcutScope !== undefined ||
        data.scope !== undefined
      );
      const hasSessionHint = typeof data.pinnedConvId === 'string' || typeof data.activeHostConvId === 'string';
      if (hasSessionHint) {
        updateActiveSessionHint({
          pinnedConvId: typeof data.pinnedConvId === 'string' ? data.pinnedConvId : undefined,
          userFocusedConvId: typeof data.activeHostConvId === 'string' ? data.activeHostConvId : undefined,
          userFocusedAt: data.activeHostConvId ? Date.now() : undefined
        });
        await controlFloatWindow({ action: 'refresh-session' }).catch(() => {});
        if (
          !isShortcutUpdate &&
          typeof data.menubarEnabled !== 'boolean' &&
          typeof data.menubarMode !== 'string' &&
          typeof data.sidebarEnabled !== 'boolean' &&
          !data.target
        ) {
          const fw = getFloatWindowStatus();
          return {
            ...getSidebarEntryStatus(),
            menubarEnabled: fw.menubarEnabled,
            menubarMode: fw.menubarMode || getMenubarMode(),
            menubarActive: fw.menubarActive,
            menubarSupported: fw.menubarSupported,
            shortcut: fw.shortcut,
            shortcutActive: fw.shortcutActive,
            floatWindow: fw
          };
        }
      }

      if (isShortcutUpdate) {
        const res = await controlFloatWindow({
          action: 'set-shortcut',
          enabled: typeof data.enabled === 'boolean' ? data.enabled : data.shortcutEnabled,
          accelerator: data.accelerator ?? data.shortcutAccelerator,
          scope: data.scope ?? data.shortcutScope,
          reset: Boolean(data.reset || data.shortcutReset)
        });
        return {
          ...getSidebarEntryStatus(),
          ...res,
          floatWindow: getFloatWindowStatus()
        };
      }

      if (typeof data.menubarMode === 'string' || data.target === 'menubar-mode') {
        const res = await controlFloatWindow({
          action: 'set-menubar-mode',
          menubarMode: data.menubarMode
        });
        return {
          ...getSidebarEntryStatus(),
          ...res,
          floatWindow: getFloatWindowStatus()
        };
      }
      if (typeof data.menubarEnabled === 'boolean' || data.target === 'menubar') {
        const res = await controlFloatWindow({
          action: 'set-menubar',
          menubarEnabled: data.menubarEnabled
        });
        return {
          ...getSidebarEntryStatus(),
          ...res,
          floatWindow: getFloatWindowStatus()
        };
      }
      if (typeof data.sidebarEnabled === 'boolean' || data.target === 'sidebar') {
        const cur = getSidebarEntryStatus();
        const nextEnabled = typeof data.sidebarEnabled === 'boolean'
          ? data.sidebarEnabled
          : !cur.sidebarEnabled;
        const out = setSidebarEntrypoint(nextEnabled);
        return {
          ...out,
          floatWindow: getFloatWindowStatus()
        };
      }
      const res = await controlFloatWindow({ action: 'set-menubar' });
      return {
        ...getSidebarEntryStatus(),
        ...res,
        floatWindow: getFloatWindowStatus()
      };
    }
  };
}

async function startOfficialSidecar() {
  if (process.env.ANTIGRAVITY_SIDECAR_HOT_RELOAD !== '0') {
    let reloadTimer = null;
    for (const f of ['main.mjs', 'collector.mjs', 'pricing.mjs', 'float_window.mjs']) {
      watchFile(join(__dirname, f), { interval: 2500 }, (curr, prev) => {
        if (curr.mtimeMs > 0 && curr.mtimeMs !== prev.mtimeMs && !reloadTimer) {
          reloadTimer = setTimeout(() => process.exit(0), 350);
        }
      });
    }
  }
  const { SidecarApp, Response } = await import('sidecar_sdk');
  const app = new SidecarApp();
  const h = createHandlers(
    () => app.config.conversationId || '',
    (body, opts) => new Response(body, opts)
  );

  app.page('/', h.indexHtml);
  app.page('/sidebar', h.indexHtml);
  for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
    app.api(route, h.staticAsset(file, contentType), 'GET');
  }

  app.api('/api/context', h.apiContext, 'GET');
  app.api('/api/history', h.apiHistory, 'GET');
  app.api('/api/settings', h.apiGetSettings, 'GET');
  app.api('/api/settings', h.apiSaveSettings, 'POST');
  app.api('/api/launch-cli', h.apiLaunchCli, 'POST');
  app.api('/api/float-window', h.apiFloatStatus, 'GET');
  app.api('/api/float-window', h.apiFloatControl, 'POST');
  app.api('/api/entrypoints', h.apiEntrypointsStatus, 'GET');
  app.api('/api/entrypoints', h.apiEntrypointsControl, 'POST');

  if (process.platform === 'darwin') {
    const t = setTimeout(() => {
      controlFloatWindow({ action: 'ensure-menubar' }).catch(() => {});
    }, 350);
    t.unref?.();
  }

  await app.run();
}

async function startStandaloneServer() {
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx >= 0 ? Number(process.argv[portIdx + 1] || 18970) : 18970;
  const sessionToken = createLoopbackSessionToken();
  const h = createHandlers(
    () => process.env.ANTIGRAVITY_CONVERSATION_ID || '',
    (body, opts) => ({ __rawResponse: true, body, ...opts })
  );

  const serveStandaloneHtml = async () => ({
    __rawResponse: true,
    body: injectCsrfMeta(readFileSync(join(__dirname, 'index.html'), 'utf-8'), sessionToken),
    contentType: 'text/html; charset=utf-8',
    headers: NO_CACHE_HEADERS
  });

  const routes = new Map([
    ['GET:/', serveStandaloneHtml],
    ['GET:/sidebar', serveStandaloneHtml],
    ['GET:/preload.js', async () => ({
      __rawResponse: true,
      body: 'window.sidecar = window.sidecar || { conversationId: new URLSearchParams(location.search).get("conversationId") || "", fetch: (u, o) => fetch(u, o), getWorkspaceUris: async () => [], onWorkspaceChange: () => () => {} };',
      contentType: 'application/javascript; charset=utf-8',
      headers: NO_CACHE_HEADERS
    })],
    ['GET:/styles.css', async () => h.staticAsset('styles.css', 'text/css; charset=utf-8')()],
    ['GET:/app.js', async () => h.staticAsset('app.js', 'application/javascript; charset=utf-8')()],
    ['GET:/api/context', h.apiContext],
    ['GET:/api/history', h.apiHistory],
    ['GET:/api/settings', h.apiGetSettings],
    ['POST:/api/settings', h.apiSaveSettings],
    ['POST:/api/launch-cli', h.apiLaunchCli],
    ['GET:/api/float-window', h.apiFloatStatus],
    ['POST:/api/float-window', h.apiFloatControl],
    ['GET:/api/entrypoints', h.apiEntrypointsStatus],
    ['POST:/api/entrypoints', h.apiEntrypointsControl]
  ]);

  const server = createServer(async (req, res) => {
    try {
      const activePort = server.address()?.port || port;
      const guard = guardLoopbackRequest(req, res, { port: activePort, token: sessionToken });
      if (!guard.ok) return;

      const lookupMethod = guard.method === 'HEAD' ? 'GET' : guard.method;
      const handler = routes.get(`${lookupMethod}:${guard.url.pathname}`);
      if (!handler) {
        res.writeHead(404, {
          'Content-Type': 'application/json; charset=utf-8',
          ...NO_CACHE_HEADERS,
          ...LOOPBACK_SECURITY_HEADERS
        });
        res.end(guard.method === 'HEAD' ? undefined : JSON.stringify({ ok: false, error: 'Not found' }));
        return;
      }

      const data = Object.fromEntries(guard.url.searchParams.entries());
      if (guard.method === 'POST') {
        const postBody = await readLoopbackJsonBody(req);
        Object.assign(data, postBody);
      }

      const out = await handler(data);
      if (out?.__rawResponse) {
        res.writeHead(out.status || 200, {
          'Content-Type': out.contentType || 'text/plain; charset=utf-8',
          ...(out.headers || {}),
          ...LOOPBACK_SECURITY_HEADERS
        });
        res.end(guard.method === 'HEAD' ? undefined : out.body);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        ...NO_CACHE_HEADERS,
        ...LOOPBACK_SECURITY_HEADERS
      });
      res.end(guard.method === 'HEAD' ? undefined : JSON.stringify(out));
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      if (!res.headersSent) {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          ...NO_CACHE_HEADERS,
          ...LOOPBACK_SECURITY_HEADERS
        });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ ok: false, error: err?.message || 'Internal server error' }));
      }
    }
  });

  const shouldOpen = process.argv.includes('--open');
  const openInBrowser = (targetUrl) => {
    if (process.platform === 'darwin') {
      execFile('/usr/bin/open', [targetUrl], () => {});
    } else if (process.platform === 'win32') {
      execFile('cmd.exe', ['/c', 'start', '', targetUrl], () => {});
    } else {
      execFile('xdg-open', [targetUrl], () => {});
    }
  };

  let retriedAnyPort = false;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !retriedAnyPort) {
      retriedAnyPort = true;
      server.listen(0, '127.0.0.1');
      return;
    }
    console.error(`[context-viewer] server failed: ${err.message}`);
    process.exitCode = 1;
  });

  server.listen(port, '127.0.0.1', () => {
    const actualUrl = `http://127.0.0.1:${server.address().port}`;
    console.log(`[context-viewer] Web 看板已启动：${actualUrl}（按 Ctrl+C 退出）`);
    if (shouldOpen) openInBrowser(actualUrl);
  });
}

if (process.argv.includes('--standalone') || !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  startStandaloneServer();
} else {
  startOfficialSidecar();
}
