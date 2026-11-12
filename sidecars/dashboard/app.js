/**
 * Context & Token Viewer — Official Antigravity Sidecar Frontend
 *
 * Works inside Antigravity's Aux Pane (`window.sidecar` injected by `preload.js`)
 * as well as standalone local preview mode.
 */

(() => {
  'use strict';

  const USD_TO_CNY = 6.72;

  const HEAT_PRESETS = {
    violet: {
      accentLight: '#7c3aed',
      accentDark: '#a78bfa',
      light: ['#edeef2', '#ddd6fe', '#c4b5fd', '#8b5cf6', '#6d28d9'],
      dark: ['#232329', '#3b1f6e', '#5b21b6', '#8b5cf6', '#c4b5fd']
    },
    emerald: {
      accentLight: '#059669',
      accentDark: '#34d399',
      light: ['#edeef2', '#d1fae5', '#6ee7b7', '#10b981', '#047857'],
      dark: ['#232329', '#064e3b', '#047857', '#10b981', '#6ee7b7']
    },
    sky: {
      accentLight: '#0284c7',
      accentDark: '#38bdf8',
      light: ['#edeef2', '#e0f2fe', '#7dd3fc', '#0ea5e9', '#0369a1'],
      dark: ['#232329', '#0c4a6e', '#0369a1', '#0ea5e9', '#7dd3fc']
    },
    amber: {
      accentLight: '#d97706',
      accentDark: '#fbbf24',
      light: ['#edeef2', '#fef3c7', '#fcd34d', '#f59e0b', '#b45309'],
      dark: ['#232329', '#5c330a', '#92400e', '#f59e0b', '#fcd34d']
    },
    rose: {
      accentLight: '#e11d48',
      accentDark: '#fb7185',
      light: ['#edeef2', '#ffe4e6', '#fda4af', '#f43f5e', '#be123c'],
      dark: ['#232329', '#60162a', '#9f1239', '#f43f5e', '#fda4af']
    }
  };

  const state = {
    activeTab: 'context',
    selectedConvId: '',
    hostConvId: window.sidecar?.conversationId || '',
    workspaceUri: '',
    contextEtag: '',
    historyEtag: '',
    contextData: null,
    historyData: null,
    settingsData: null,

    // History view controls
    sourceFilter: 'all',
    chartMode: 'daily',
    heatPageOffset: 0,
    selectedBucketKey: '',

    // Cost view controls
    costScope: 'period',
    costMode: 'hybrid',
    turnsFilter: 'all', // 'all' | 'spike' | 'tools'

    // Appearance & gauge preferences
    ui: {
      themeMode: 'auto', // 'auto' | 'light' | 'dark'
      preset: 'violet',
      customLevels: null, // [c0, c1, c2, c3, c4] or null
      customAccent: '',
      budgetOverride: 0 // 0 = auto server budget, or 200000 / 256000 / 1000000
    },

    presetsPopulated: false,
    menubarEnabled: window.__CV_MENUBAR_ENABLED__ ?? true,
    menubarMode: window.__CV_MENUBAR_MODE__ || 'context',
    menubarSupported: true,
    hostHidden: Boolean(window.__CV_INITIAL_HIDDEN__),
    floatRunning: Boolean(window.__CV_FLOAT_MODE__) && !Boolean(window.__CV_INITIAL_HIDDEN__),
    floatPinned: Boolean(window.__CV_FLOAT_PINNED__ ?? true),
    toastTimer: null
  };

  const $ = (id) => document.getElementById(id);

  // -------------------------------------------------------------------------
  // Deterministic Chinese-English / Number Typography Layer
  // -------------------------------------------------------------------------

  function formatZh(raw) {
    if (raw === null || raw === undefined) return '';
    const str = String(raw);
    if (!str) return '';
    if (str === '—' || str === '--') return '--';

    // Temporarily mask URLs / URI schemes so they remain untouched
    const masks = [];
    let out = str.replace(/(?:https?|file|sidecar|customization):\/\/[^\s)]+/g, (m) => {
      masks.push(m);
      return `\u0000URL${masks.length - 1}\u0000`;
    });

    // Normalize prose em-dashes to ` -- `
    out = out.replace(/\s*——\s*/g, ' -- ');

    // Insert space between CJK characters and ASCII letters/numbers/currency symbols
    out = out.replace(/([\u4e00-\u9fff])([A-Za-z0-9$¥€£₩₹₺₦₱฿₫])/g, '$1 $2');
    out = out.replace(/([A-Za-z0-9%])([\u4e00-\u9fff])/g, '$1 $2');

    // Collapse accidental double spaces around inserted boundaries
    out = out.replace(/ {2,}/g, ' ');

    if (masks.length) {
      out = out.replace(/\u0000URL(\d+)\u0000/g, (_, idx) => masks[Number(idx)] || '');
    }
    return out;
  }

  function setText(elOrId, val) {
    const el = typeof elOrId === 'string' ? $(elOrId) : elOrId;
    if (!el) return;
    el.textContent = formatZh(val);
  }

  function esc(raw) {
    return String(raw ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escZh(raw) {
    return esc(formatZh(raw));
  }

  function normalizeStaticDomTypography() {
    const skipTags = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'INPUT', 'SELECT', 'TEXTAREA']);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const p = node.parentElement;
      if (!p || skipTags.has(p.tagName) || p.classList.contains('mono-tag')) continue;
      const v = node.nodeValue;
      if (v && /[\u4e00-\u9fff—]/.test(v)) {
        const formatted = formatZh(v);
        if (formatted !== v) node.nodeValue = formatted;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Formatting Helpers
  // -------------------------------------------------------------------------

  function fmtTokens(n, digits = 2) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '--';
    const v = Number(n);
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(digits)}B`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(digits)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
    return Math.round(v).toLocaleString('en-US');
  }

  function fmtInt(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '--';
    return Math.round(Number(n)).toLocaleString('en-US');
  }

  function fmtUSD(v, minDec = 2) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '--';
    const num = Number(v);
    if (num === 0) return '$0.00';
    if (num > 0 && num < 0.01) return `$${num.toFixed(4)}`;
    return `$${num.toFixed(minDec)}`;
  }

  function fmtCNY(usdVal) {
    if (usdVal === null || usdVal === undefined || Number.isNaN(Number(usdVal))) return '--';
    const cny = Number(usdVal) * USD_TO_CNY;
    if (cny === 0) return '¥0.00';
    if (cny > 0 && cny < 0.05) return `¥${cny.toFixed(3)}`;
    return `¥${cny.toFixed(2)}`;
  }

  function fmtSec(sec) {
    if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return '--';
    const s = Number(sec);
    if (s >= 60) {
      const m = Math.floor(s / 60);
      const rem = (s - m * 60).toFixed(1);
      return `${m}m ${rem}s`;
    }
    return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  }

  function fmtBytes(bytes) {
    const b = Number(bytes || 0);
    if (b <= 0) return '0 B';
    if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
    if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  }

  function showToast(msg, durationMs = 2600) {
    const el = $('toast');
    if (!el) return;
    setText(el, msg);
    el.classList.remove('hidden');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, durationMs);
  }

  // -------------------------------------------------------------------------
  // Host Theme & Palette Engine
  // -------------------------------------------------------------------------

  function resolveComputedLuminance(cssExpr) {
    if (!document.documentElement) return null;
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;color:${cssExpr}`;
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color || '';
    probe.remove();
    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return null;
    const scale = computed.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function detectHostDark() {
    const inlineBg = document.documentElement.style.getPropertyValue('--background').trim()
      || document.documentElement.style.getPropertyValue('--card').trim();
    if (inlineBg) {
      const lum = resolveComputedLuminance('var(--background, var(--card, #f6f7f9))');
      if (lum !== null) return lum < 0.5;
    }
    return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  }

  function isEffectiveDark() {
    if (state.ui.themeMode === 'dark') return true;
    if (state.ui.themeMode === 'light') return false;
    return detectHostDark();
  }

  function setRootStyleVar(root, key, val) {
    if (root.style.getPropertyValue(key).trim() !== val) {
      root.style.setProperty(key, val);
    }
  }

  function applyAppearanceToDom() {
    const root = document.documentElement;
    const dark = isEffectiveDark();

    if (root.getAttribute('data-theme') !== (dark ? 'dark' : 'light')) {
      root.setAttribute('data-theme', dark ? 'dark' : 'light');
    }
    if (state.ui.themeMode === 'light' || state.ui.themeMode === 'dark') {
      if (root.getAttribute('data-force-mode') !== state.ui.themeMode) {
        root.setAttribute('data-force-mode', state.ui.themeMode);
      }
    } else if (root.hasAttribute('data-force-mode')) {
      root.removeAttribute('data-force-mode');
    }

    const presetObj = HEAT_PRESETS[state.ui.preset] || HEAT_PRESETS.violet;
    const baseLevels = dark ? presetObj.dark : presetObj.light;
    const levels = Array.isArray(state.ui.customLevels) && state.ui.customLevels.length === 5
      ? state.ui.customLevels
      : baseLevels;
    const accent = state.ui.customAccent || (dark ? presetObj.accentDark : presetObj.accentLight);

    for (let i = 0; i < 5; i++) {
      setRootStyleVar(root, `--heat-${i}`, levels[i]);
      const picker = $(`col-lvl${i}`);
      if (picker && /^#[0-9a-f]{6}$/i.test(levels[i])) {
        picker.value = levels[i];
      }
    }
    setRootStyleVar(root, '--user-accent', accent);
    const accentPicker = $('col-accent');
    if (accentPicker && /^#[0-9a-f]{6}$/i.test(accent)) {
      accentPicker.value = accent;
    }

    // Update theme buttons & icon
    document.querySelectorAll('#theme-seg .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeMode === state.ui.themeMode);
    });
    document.querySelectorAll('#heat-presets .preset-chip').forEach((chip) => {
      const active = !state.ui.customLevels && chip.dataset.preset === state.ui.preset;
      chip.classList.toggle('active', active);
    });
    document.querySelectorAll('#budget-seg .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.budget || 0) === (state.ui.budgetOverride || 0));
    });

    const icTheme = $('ic-theme');
    const btnTheme = $('btn-theme');
    if (icTheme) {
      if (state.ui.themeMode === 'light') {
        icTheme.innerHTML = '<circle cx="8" cy="8" r="3.3"/><path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/>';
      } else if (state.ui.themeMode === 'dark') {
        icTheme.innerHTML = '<path d="M8.4 2.1a5.8 5.8 0 1 0 5.5 7.5A4.6 4.6 0 0 1 8.4 2.1Z"/>';
      } else {
        icTheme.innerHTML = '<circle cx="8" cy="8" r="5.8"/><path d="M8 2.2v11.6A5.8 5.8 0 0 0 8 2.2Z" class="fill"/>';
      }
    }
    if (btnTheme) {
      const tipMap = {
        auto: `当前：跟随宿主主题（已识别为${dark ? '深色' : '浅色'}，点击切换为固定浅色）`,
        light: '当前：固定浅色主题（点击切换为固定深色）',
        dark: '当前：固定深色主题（点击切换回跟随宿主主题）'
      };
      const tip = tipMap[state.ui.themeMode] || tipMap.auto;
      btnTheme.title = tip;
      btnTheme.setAttribute('aria-label', tip);
    }
  }

  async function persistUiPreferences() {
    try {
      await apiFetch('/api/settings', {
        method: 'POST',
        body: {
          uiPreferences: {
            themeMode: state.ui.themeMode,
            preset: state.ui.preset,
            customLevels: state.ui.customLevels,
            customAccent: state.ui.customAccent,
            budgetOverride: state.ui.budgetOverride || 0
          }
        }
      });
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Sidecar API Client
  // -------------------------------------------------------------------------

  async function apiFetch(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    if (body && typeof body === 'object') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const fetcher = window.sidecar?.fetch
      ? window.sidecar.fetch.bind(window.sidecar)
      : window.fetch.bind(window);
    const res = await fetcher(path, { method, headers, body });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  async function loadContext(force = false) {
    const liveHostId = window.sidecar?.conversationId || state.hostConvId || '';
    if (liveHostId && liveHostId !== state.hostConvId) {
      state.hostConvId = liveHostId;
      if (!state.selectedConvId) state.contextEtag = '';
    }
    const targetConv = state.selectedConvId || state.hostConvId || '';
    const qs = new URLSearchParams();
    if (targetConv) qs.set('conversationId', targetConv);
    if (force) qs.set('force', '1');
    else if (state.contextEtag) qs.set('etag', state.contextEtag);

    const snap = await apiFetch(`/api/context?${qs.toString()}`);
    if (snap?.recentConversations) {
      renderConversationPicker(snap.recentConversations, snap.conversationId);
    }
    if (snap?.unchanged && state.contextData) {
      return;
    }
    if (snap?.ok) {
      state.contextEtag = snap.etag || '';
      state.contextData = snap;
      renderContextPanel(snap);
      renderTopCapsules();
    }
  }

  async function loadHistory(force = false) {
    const qs = new URLSearchParams();
    if (force) qs.set('force', '1');
    else if (state.historyEtag) qs.set('etag', state.historyEtag);

    const hist = await apiFetch(`/api/history?${qs.toString()}`);
    if (hist?.unchanged && state.historyData) {
      return;
    }
    if (hist?.ok) {
      state.historyEtag = hist.etag || '';
      state.historyData = hist;
      populatePlanPresetsIfNeeded(hist.presets);
      renderHistoryPanel(hist);
      renderCostPanel(hist);
      renderTopCapsules();
    }
  }

  async function loadInitialSettings() {
    try {
      const s = await apiFetch('/api/settings');
      if (!s?.ok) return;
      state.settingsData = s;
      const prefs = s.uiPreferences || {};
      if (prefs.themeMode && ['auto', 'light', 'dark'].includes(prefs.themeMode)) {
        state.ui.themeMode = prefs.themeMode;
      }
      if (prefs.preset && HEAT_PRESETS[prefs.preset]) {
        state.ui.preset = prefs.preset;
      }
      if (Array.isArray(prefs.customLevels) && prefs.customLevels.length === 5) {
        state.ui.customLevels = prefs.customLevels;
      }
      if (typeof prefs.customAccent === 'string') {
        state.ui.customAccent = prefs.customAccent;
      }
      if (typeof prefs.budgetOverride === 'number' && [0, 200000, 256000, 1000000].includes(prefs.budgetOverride)) {
        state.ui.budgetOverride = prefs.budgetOverride;
      }
      if (typeof s.entrypoints?.sidebarEnabled === 'boolean') {
        state.sidebarEntryEnabled = s.entrypoints.sidebarEnabled;
      }
      applyAppearanceToDom();
      syncFloatButtonUi();
      populatePlanPresetsIfNeeded(s.presets);
      syncPlanFormInputs(s.planStatus, s.customPlan);
      if (state.contextData) {
        renderContextPanel(state.contextData);
        renderTopCapsules();
      }
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Top Capsules & Conversation Switcher
  // -------------------------------------------------------------------------

  function computeEffectiveWindow(ctx = {}) {
    const serverBudget = Number(ctx.budget || 256000);
    const budget = state.ui.budgetOverride > 0 ? state.ui.budgetOverride : serverBudget;
    const used = typeof ctx.used === 'number' ? ctx.used : null;
    const pct = used !== null && budget > 0 ? Number(((used / budget) * 100).toFixed(1)) : null;
    const remaining = used !== null && budget > 0 ? Math.max(0, budget - used) : null;
    return { budget, serverBudget, used, pct, remaining, isOverridden: state.ui.budgetOverride > 0 };
  }

  function renderTopCapsules() {
    const ctx = state.contextData?.context;
    const spd = state.contextData?.speed;
    const hist = state.historyData;

    const win = computeEffectiveWindow(ctx);
    const pct = win.pct;
    setText('cap-ctx-pct', pct !== null ? `${pct.toFixed(0)}%` : '--%');

    const miniRing = $('mini-ring-fill');
    if (miniRing) {
      const circum = 45.24; // 2 * PI * 7.2
      const ratio = pct !== null ? Math.min(1, Math.max(0, pct / 100)) : 0;
      miniRing.setAttribute('stroke-dasharray', `${(ratio * circum).toFixed(2)} ${circum}`);
      miniRing.style.stroke = resolveHealthStroke(pct, ctx?.error?.kind);
    }

    const tps = spd?.tps ?? spd?.streamingTps ?? null;
    setText('cap-speed-val', tps !== null ? `${tps} tok/s` : '-- tok/s');

    const srcSummary = hist?.analyticsBySource?.[state.sourceFilter]?.summary
      || hist?.analyticsBySource?.all?.summary;
    setText('cap-tok-val', srcSummary ? fmtTokens(srcSummary.grandTotalTokens) : '--');
  }

  function resolveHealthStroke(pct, errKind) {
    if (errKind && errKind !== 'none' && errKind !== 'canceled') return 'var(--danger)';
    if (pct !== null && pct >= 90) return 'var(--danger)';
    if (pct !== null && pct >= 75) return 'var(--warn)';
    return 'var(--cv-accent)';
  }

  function renderConversationPicker(list = [], activeId = '') {
    const sel = $('conv-select');
    const followBtn = $('btn-follow-current');
    if (followBtn) followBtn.classList.toggle('hidden', !state.selectedConvId);
    if (!sel) return;
    const prevVal = state.selectedConvId;
    const optionsHtml = [
      `<option value="">${escZh('自动跟随当前对话')}</option>`
    ];
    for (const item of list) {
      const tag = item.source === 'cli' ? '[CLI] ' : '';
      const shortTitle = String(item.title || item.id.slice(0, 8)).slice(0, 22);
      const tokBadge = item.lastContextTokens > 0 ? ` · ${fmtTokens(item.lastContextTokens, 0)}` : '';
      const isCurrentAuto = !prevVal && item.id === activeId;
      const suffix = isCurrentAuto ? '（当前）' : '';
      optionsHtml.push(
        `<option value="${esc(item.id)}">${escZh(`${tag}${shortTitle}${tokBadge}${suffix}`)}</option>`
      );
    }
    sel.innerHTML = optionsHtml.join('');
    sel.value = prevVal || '';
  }

  // -------------------------------------------------------------------------
  // TAB 1: Context & Speed Renderer
  // -------------------------------------------------------------------------

  function renderContextPanel(snap) {
    const ctx = snap.context || {};
    const spd = snap.speed;
    const audit = snap.audit || {};
    const err = ctx.error || { kind: 'none' };
    const win = computeEffectiveWindow(ctx);
    const pct = win.pct;

    setText('ctx-model-badge', ctx.model || '未识别模型');

    const pendingBadge = $('ctx-pending-badge');
    if (pendingBadge) {
      if (ctx.pendingTokens > 0) {
        pendingBadge.classList.remove('hidden');
        setText(pendingBadge, `+待发 ~${fmtTokens(ctx.pendingTokens, 1)}`);
      } else {
        pendingBadge.classList.add('hidden');
      }
    }

    setText('conv-live-title', snap.conversationTitle || `会话 ${snap.conversationId || ''}`);
    setText(
      'conv-live-steps',
      `${fmtInt(audit.turnsCount || 0)} 轮响应 · ${fmtInt(audit.totalSteps || 0)} 步 · ${fmtInt(audit.toolCallsCount || 0)} 次工具`
    );

    // Health status pill
    const pill = $('ctx-health-pill');
    if (pill) {
      let cls = 'good';
      let label = '运行健康';
      if (err.kind && err.kind !== 'none') {
        cls = err.kind === 'canceled' ? 'neutral' : 'danger';
        label = err.badgeText || err.title || '异常';
      } else if (pct === null) {
        cls = 'neutral';
        label = '待首轮请求';
      } else if (pct >= 90) {
        cls = 'danger';
        label = '临近上限';
      } else if (pct >= 75) {
        cls = 'warn';
        label = '占用偏高';
      }
      pill.className = `status-pill ${cls}`;
      setText(pill, label);
    }

    // Hero circular gauge (r = 35 => C = 219.91)
    const circum = 219.91;
    setText('ctx-pct-big', pct !== null ? `${pct.toFixed(1)}%` : '--%');
    setText('ctx-gauge-sub', win.isOverridden ? `按 ${fmtTokens(win.budget, 0)} 基准` : '预算占比');

    const heroFill = $('hero-ring-fill');
    const heroCache = $('hero-ring-cache');
    if (heroFill) {
      const ratio = pct !== null ? Math.min(1, Math.max(0, pct / 100)) : 0;
      heroFill.setAttribute('stroke-dasharray', `${(ratio * circum).toFixed(2)} ${circum}`);
      heroFill.style.stroke = resolveHealthStroke(pct, err.kind);
    }
    if (heroCache) {
      const cacheRatio = win.budget > 0 && ctx.cacheTokens
        ? Math.min(1, Math.max(0, ctx.cacheTokens / win.budget))
        : 0;
      heroCache.setAttribute('stroke-dasharray', `${(cacheRatio * circum).toFixed(2)} ${circum}`);
    }

    // 4 Metric Cells
    setText('ctx-used', win.used !== null ? fmtTokens(win.used) : '--');
    if (win.used !== null) {
      const pendNote = ctx.pendingTokens > 0 ? ` · 待发 ~${fmtTokens(ctx.pendingTokens, 1)}` : '';
      setText(
        'ctx-used-sub',
        `入 ${fmtTokens(ctx.inputTokens || 0, 1)} · 缓 ${fmtTokens(ctx.cacheTokens || 0, 1)}${pendNote}`
      );
    } else {
      setText('ctx-used-sub', `本地归档约 ${fmtTokens(audit.localTotal?.low || 0, 1)}~${fmtTokens(audit.localTotal?.high || 0, 1)}`);
    }

    setText('ctx-budget', fmtTokens(win.budget));
    setText('ctx-budget-sub', win.isOverridden ? `服务端默认 ${fmtTokens(win.serverBudget, 0)}` : '自动压缩阈值');
    setText('ctx-rem', win.remaining !== null ? fmtTokens(win.remaining) : '--');
    setText(
      'ctx-rem-sub',
      win.remaining !== null && win.budget > 0
        ? `剩余 ${Math.max(0, 100 - (pct || 0)).toFixed(1)}% 空间`
        : '等待服务端统计'
    );

    setText('ctx-cache-rate', ctx.cacheHitPercent !== null ? `${ctx.cacheHitPercent.toFixed(1)}%` : '--');
    setText(
      'ctx-cache-sub',
      ctx.cacheTokens ? `命中 ${fmtTokens(ctx.cacheTokens)}` : '缓存读取占比'
    );

    // 3-Segment Context Bar (System / Tools / Messages)
    renderSegmentedBreakdown(ctx, audit);

    // Session Cumulative 4-Dimension Throughput
    const st = ctx.sessionTotals || {};
    setText('cum-cache-overall', st.cacheHitPercent != null ? `累计缓存率 ${st.cacheHitPercent.toFixed(1)}%` : '累计缓存率 --');
    setText('cum-cache-tok', fmtTokens(st.cacheTokens || 0));
    setText('cum-input-tok', fmtTokens(st.inputTokens || 0));
    setText('cum-output-tok', fmtTokens(st.outputTokens || 0));
    setText('cum-think-sub', `含思考 ${fmtTokens(st.thinkingTokens || 0, 1)}`);
    setText('cum-total-tok', fmtTokens(st.totalTokens || 0));

    // Takeaway & Error Diagnostics
    const takeaway = $('ctx-takeaway');
    if (takeaway) {
      takeaway.classList.remove('warn', 'danger');
      if (err.kind && err.kind !== 'none') {
        if (err.kind !== 'canceled') takeaway.classList.add('danger');
        setText(takeaway, `${err.title}：${err.detail}`);
      } else if (pct === null) {
        setText(takeaway, `当前会话（${snap.conversationTitle}）暂无已完成模型轮次；发送消息后自动同步精确窗口占用。`);
      } else if (pct >= 88) {
        takeaway.classList.add('danger');
        setText(takeaway, `当前窗口已使用 ${pct.toFixed(1)}%，接近上限阈值，建议适时执行 /compact 或拆分新会话以保持响应速度。`);
      } else if (pct >= 72) {
        takeaway.classList.add('warn');
        setText(takeaway, `当前窗口已用 ${pct.toFixed(1)}%，缓存命中率 ${ctx.cacheHitPercent ?? 0}%，后续长输出轮次可能触发自动摘要。`);
      } else {
        const cacheNote = ctx.cacheHitPercent !== null && ctx.cacheHitPercent >= 50
          ? `缓存命中高达 ${ctx.cacheHitPercent.toFixed(1)}%，显著降低首字延迟与折算成本。`
          : '上下文容量充裕，推理与工具调用处于最佳窗口区间。';
        setText(takeaway, `会话「${snap.conversationTitle}」窗口健康（已用 ${fmtTokens(win.used)} / ${fmtTokens(win.budget)}）。${cacheNote}`);
      }
    }

    // Round & Session API Cost Strip
    setText(
      'ctx-round-cost',
      ctx.isPriced ? `${fmtUSD(ctx.roundCostUSD)}（约 ${fmtCNY(ctx.roundCostUSD)}）` : '--'
    );
    setText(
      'ctx-session-cost',
      ctx.sessionCostUSD > 0 ? `${fmtUSD(ctx.sessionCostUSD)}（约 ${fmtCNY(ctx.sessionCostUSD)}）` : '$0.00'
    );

    // Card 2: Speed & Latency
    renderSpeedCard(spd, ctx, snap.sparkline || []);

    // Card 2.5: Per-Turn Timeline
    renderTurnsTimelineCard(snap.turns || [], audit.turnsCount || 0);

    // Card 3: Server Context Breakdown Details
    renderServerBreakdownCard(ctx.breakdown);

    // Card 4: Technical Audit & Attachments
    renderTechnicalAuditCard(snap);
  }

  function renderSegmentedBreakdown(ctx, audit) {
    let sysTok = 0;
    let toolsTok = 0;
    let msgsTok = 0;
    let isExact = false;

    if (ctx.breakdown?.groups?.length) {
      isExact = true;
      for (const g of ctx.breakdown.groups) {
        if (g.name === 'System Prompt') sysTok += g.tokens || 0;
        else if (g.name === 'Tools') toolsTok += g.tokens || 0;
        else msgsTok += g.tokens || 0;
      }
    } else if (audit?.groups) {
      const g = audit.groups;
      const mid = (m) => (m ? Math.round(((m.low || 0) + (m.high || 0)) / 2) : 0);
      sysTok = mid(g.system);
      toolsTok = mid(g.definitions) + mid(g.tools);
      msgsTok = mid(g.user) + mid(g.assistant) + mid(g.thinking) + mid(g.summaries) + mid(audit.attachmentTotal);
    }

    const sum = sysTok + toolsTok + msgsTok;
    const pSys = sum > 0 ? (sysTok / sum) * 100 : 0;
    const pTools = sum > 0 ? (toolsTok / sum) * 100 : 0;
    const pMsgs = sum > 0 ? Math.max(0, 100 - pSys - pTools) : 0;

    if ($('seg-sys')) $('seg-sys').style.width = `${pSys.toFixed(1)}%`;
    if ($('seg-tools')) $('seg-tools').style.width = `${pTools.toFixed(1)}%`;
    if ($('seg-msgs')) $('seg-msgs').style.width = `${pMsgs.toFixed(1)}%`;

    const leg = $('ctx-seg-legend');
    if (leg) {
      if (sum <= 0) {
        leg.innerHTML = `<span class="muted">${escZh('暂无上下文构成明细')}</span>`;
      } else {
        const items = [
          { label: '系统提示词', tok: sysTok, pct: pSys, col: 'var(--seg-sys-col)' },
          { label: '工具定义与调用', tok: toolsTok, pct: pTools, col: 'var(--seg-tools-col)' },
          { label: '对话与思考历史', tok: msgsTok, pct: pMsgs, col: 'var(--seg-msgs-col)' }
        ];
        leg.innerHTML = items.map((it) => (
          `<span class="seg-leg-item">` +
          `<i class="seg-dot" style="background:${it.col}"></i>` +
          `<span>${escZh(`${it.label} ${fmtTokens(it.tok, 1)} (${it.pct.toFixed(0)}%)`)}</span>` +
          `</span>`
        )).join('') + (!isExact ? `<span class="muted">${escZh('· 本地启发式占比')}</span>` : '');
      }
    }
  }

  function renderSpeedCard(spd, ctx, sparkline) {
    setText('speed-source-tag', spd?.isServerExact ? '服务端精确计时' : '归档时间戳估算');
    setText(
      'sp-avg-peak-chip',
      spd?.avgTps != null
        ? `均值 ${spd.avgTps} · 峰值 ${spd.peakTps ?? spd.avgTps} tok/s`
        : '均值 -- · 峰值 --'
    );

    const pill = $('speed-pill');
    if (pill) {
      if (!spd || (spd.tps === null && spd.duration === null)) {
        pill.className = 'status-pill neutral';
        setText(pill, '待生成');
      } else if ((spd.tps || 0) >= 65) {
        pill.className = 'status-pill good';
        setText(pill, '极速响应');
      } else if ((spd.tps || 0) >= 28) {
        pill.className = 'status-pill good';
        setText(pill, '输出流畅');
      } else {
        pill.className = 'status-pill warn';
        setText(pill, spd.thinkingTokens > spd.responseTokens ? '深度思考轮次' : '平稳生成');
      }
    }

    setText('sp-tps', spd?.tps != null ? `${spd.tps} tok/s` : '--');
    setText('sp-stream-tps', spd?.streamingTps != null ? `流式峰值 ${spd.streamingTps} tok/s` : '流式峰值 --');
    setText('sp-dur', spd?.duration != null ? fmtSec(spd.duration) : '--');
    setText('sp-stream-sec', spd?.streamingSec != null ? `流传输 ${fmtSec(spd.streamingSec)}` : '流传输 --');
    setText('sp-ttft', spd?.ttft != null ? fmtSec(spd.ttft) : '--');
    setText('sp-out', spd?.outputTokens != null ? `${fmtTokens(spd.outputTokens)} tok` : '--');
    setText(
      'sp-think-sub',
      spd ? `思考 ${fmtTokens(spd.thinkingTokens || 0, 1)} / 正文 ${fmtTokens(spd.responseTokens || 0, 1)}` : '思考 -- / 正文 --'
    );

    if (!spd) {
      setText('sp-takeaway', '当前会话尚无已完成输出轮次，等待首次模型响应后展示速度与首字延迟。');
    } else if (spd.ttft !== null && spd.thinkingTokens > 0) {
      setText(
        'sp-takeaway',
        `首字前推理准备耗时 ${fmtSec(spd.ttft)}（含 ${fmtInt(spd.thinkingTokens)} 思考 Token），正文流式输出 ${fmtInt(spd.responseTokens)} Token，总耗时 ${fmtSec(spd.duration)}。`
      );
    } else {
      setText(
        'sp-takeaway',
        `最近一轮共生成 ${fmtInt(spd.outputTokens || 0)} Token，总耗时 ${fmtSec(spd.duration)}，综合吞吐 ${spd.tps ?? '--'} tok/s。`
      );
    }

    // Active Model Quota Bar
    const qBox = $('ctx-quota-box');
    const q = ctx.quota;
    if (qBox) {
      if (q && typeof q.remainingPercent === 'number') {
        qBox.classList.remove('hidden');
        setText('ctx-quota-title', `${q.label} 配额池余量`);
        const resetNote = q.resetTimeZh ? ` · ${q.resetTimeZh}重置` : '';
        setText('ctx-quota-val', `${q.remainingPercent.toFixed(1)}%${resetNote}`);
        const bar = $('ctx-quota-bar');
        if (bar) {
          bar.style.width = `${Math.min(100, Math.max(0, q.remainingPercent))}%`;
          bar.style.background = q.remainingPercent <= 15
            ? 'var(--danger)'
            : q.remainingPercent <= 40
              ? 'var(--warn)'
              : 'var(--good)';
        }
      } else {
        qBox.classList.add('hidden');
      }
    }

    // Sparkline SVG
    const sparkWrap = $('spark-wrap');
    const sparkSvg = $('spark-svg');
    if (sparkWrap && sparkSvg) {
      if (sparkline.length >= 2) {
        sparkWrap.classList.remove('hidden');
        const maxTok = Math.max(...sparkline.map((s) => s.total || 0), 1);
        setText('spark-meta', `近 ${sparkline.length} 轮 · 峰值 ${fmtTokens(maxTok)}`);

        const W = 360;
        const H = 48;
        const padX = 6;
        const padY = 6;
        const pts = sparkline.map((pt, i) => {
          const x = padX + (i / (sparkline.length - 1)) * (W - padX * 2);
          const y = H - padY - ((pt.total || 0) / maxTok) * (H - padY * 2);
          return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), ...pt };
        });
        const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
        const areaPath = `${linePath} L${pts[pts.length - 1].x},${H} L${pts[0].x},${H} Z`;
        const last = pts[pts.length - 1];

        sparkSvg.innerHTML =
          `<defs><linearGradient id="spkGrad" x1="0" y1="0" x2="0" y2="1">` +
          `<stop offset="0%" stop-color="var(--cv-accent)" stop-opacity="0.32"/>` +
          `<stop offset="100%" stop-color="var(--cv-accent)" stop-opacity="0.02"/>` +
          `</linearGradient></defs>` +
          `<path d="${areaPath}" fill="url(#spkGrad)"/>` +
          `<path d="${linePath}" fill="none" stroke="var(--cv-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>` +
          `<circle cx="${last.x}" cy="${last.y}" r="2.8" fill="var(--cv-accent)"/>`;
      } else {
        sparkWrap.classList.add('hidden');
      }
    }
  }

  function fmtLocalTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderTurnsTimelineCard(turns = [], totalTurnsCount = 0) {
    setText('turns-count-chip', `${fmtInt(totalTurnsCount || turns.length)} 轮`);
    const listEl = $('turns-timeline');
    if (!listEl) return;

    let filtered = turns;
    if (state.turnsFilter === 'spike') {
      filtered = turns.filter((t) => Math.abs(t.deltaTokens || 0) >= 5000);
    } else if (state.turnsFilter === 'tools') {
      filtered = turns.filter((t) => Array.isArray(t.tools) && t.tools.length > 0);
    }

    if (!filtered.length) {
      const emptyMsg = turns.length > 0
        ? '当前筛选条件下没有匹配的轮次'
        : '暂无已完成轮次记录';
      listEl.innerHTML = `<div class="kv-row"><span class="muted">${escZh(emptyMsg)}</span></div>`;
      return;
    }

    listEl.innerHTML = filtered.map((t) => {
      const delta = Number(t.deltaTokens || 0);
      const sign = delta >= 0 ? '+' : '-';
      const deltaCls = delta < -1000 ? 'compact' : delta >= 8000 ? 'spike' : '';
      const deltaStr = `${sign}${fmtTokens(Math.abs(delta), 1)}`;
      const timeStr = fmtLocalTime(t.createdAt);
      const stepLabel = t.stepIndex != null ? ` · Step ${t.stepIndex}` : '';
      const thinkSub = t.thinkingTokens > 0 ? `（思 ${fmtTokens(t.thinkingTokens, 1)}）` : '';

      const costChip = t.isPriced && t.costUSD > 0
        ? `<span class="turn-chip cost" title="单轮 API 等值参考">${esc(fmtUSD(t.costUSD))}</span>`
        : '';
      const ttftSub = t.ttft != null ? ` · 首字 ${t.ttft}s` : (t.duration != null ? ` · ${t.duration}s` : '');
      const speedChip = t.tps != null
        ? `<span class="turn-chip speed">${esc(`${t.tps} tok/s${ttftSub}`)}</span>`
        : '';
      const toolsHtml = (t.tools || []).map((toolName) =>
        `<span class="turn-chip tool">${esc(toolName)}</span>`
      ).join('');

      return (
        `<div class="turn-item">` +
        `<div class="turn-top">` +
        `<span class="turn-idx">${escZh(`第 #${t.turnIndex} 轮${stepLabel}`)}</span>` +
        `<span class="turn-ctx-group">` +
        `<span class="turn-ctx-num">${esc(`${fmtInt(t.totalTokens)} tok`)}</span>` +
        `<span class="delta-tag ${deltaCls}" title="较上一轮上下文窗口变化">${esc(deltaStr)}</span>` +
        `</span>` +
        `</div>` +
        `<div class="turn-meta-row">` +
        (timeStr ? `<span>${esc(timeStr)}</span><span>·</span>` : '') +
        `<span>${escZh(`缓存 ${t.cacheHitPercent ?? 0}%`)}</span>` +
        `<span>·</span>` +
        `<span>${escZh(`入 ${fmtTokens(t.inputTokens, 1)} / 出 ${fmtTokens(t.outputTokens, 1)}${thinkSub}`)}</span>` +
        costChip +
        speedChip +
        toolsHtml +
        `</div>` +
        `</div>`
      );
    }).join('');
  }

  function renderServerBreakdownCard(bd) {
    const card = $('breakdown-card');
    const list = $('breakdown-groups');
    if (!card || !list) return;

    if (!bd?.groups?.length) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    const nameMap = {
      'System Prompt': 'System Prompt（系统提示词与规则）',
      'Tools': 'Tools（MCP 与内置工具定义）',
      'Chat Messages': 'Chat Messages（对话消息、思考与工具结果）'
    };
    const total = Math.max(1, bd.totalTokens || bd.groups.reduce((a, g) => a + (g.tokens || 0), 0));

    list.innerHTML = bd.groups.map((g) => {
      const pct = (((g.tokens || 0) / total) * 100).toFixed(1);
      const rawChildren = g.children || g.topChildren || [];
      const children = rawChildren.slice(0, 18).map((c) =>
        `<span class="bd-chip">${esc(c.name)} · ${fmtInt(c.tokens)}</span>`
      ).join('');
      const totalChildCount = g.childrenCount || rawChildren.length;
      const moreCount = Math.max(0, totalChildCount - 18);
      const moreChip = moreCount > 0 ? `<span class="bd-chip muted">+${moreCount} 项</span>` : '';
      return (
        `<div class="bd-group">` +
        `<div class="bd-head"><span>${escZh(nameMap[g.name] || g.name)}</span>` +
        `<span class="num">${escZh(`${fmtInt(g.tokens)} tok (${pct}%)`)}</span></div>` +
        (children ? `<div class="bd-children">${children}${moreChip}</div>` : '') +
        `</div>`
      );
    }).join('');
  }

  function renderTechnicalAuditCard(snap) {
    const ctx = snap.context || {};
    const audit = snap.audit || {};

    const reqRows = [
      ['会话标题', snap.conversationTitle || '--'],
      ['会话 ID', snap.conversationId || '--'],
      ['当前模型', ctx.model || '--'],
      ['输入 Token（未命中缓存）', fmtInt(ctx.inputTokens)],
      ['缓存读取 Token（优惠计费）', fmtInt(ctx.cacheTokens)],
      ['输出总 Token', fmtInt(ctx.outputTokens)],
      ['其中：推理思考 / 可见回复', `${fmtInt(ctx.thinkingTokens)} / ${fmtInt(ctx.responseTokens)}`],
      ['服务端报告总计 / 下轮预估', `${fmtInt(ctx.actual)} / ${fmtInt(ctx.estimate)}`],
      ['归档步数 / 模型请求轮数', `${fmtInt(audit.totalSteps)} 步 / ${fmtInt(audit.turnsCount)} 轮`],
      ['累计工具调用次数', `${fmtInt(audit.toolCallsCount)} 次`]
    ];

    const reqKv = $('req-kv');
    if (reqKv) {
      reqKv.innerHTML = reqRows.map(([k, v]) =>
        `<div class="kv-row"><span class="kv-k">${escZh(k)}</span><span class="kv-v">${escZh(v)}</span></div>`
      ).join('');
    }

    const g = audit.groups || {};
    const fmtRange = (m) => {
      if (!m || (!m.low && !m.high && !m.bytes)) return '0 tok';
      const tokRange = m.low === m.high ? `${fmtInt(m.low)} tok` : `${fmtInt(m.low)} ~ ${fmtInt(m.high)} tok`;
      return `${tokRange}（${fmtBytes(m.bytes)}）`;
    };

    const localRows = [
      ['用户输入消息（共 ' + (audit.userMessages || 0) + ' 条）', fmtRange(g.user)],
      ['助手回复正文（共 ' + (audit.assistantMessages || 0) + ' 条）', fmtRange(g.assistant)],
      ['模型思考链归档', fmtRange(g.thinking)],
      ['工具调用入参与返回日志', fmtRange(g.tools)],
      ['检查点压缩摘要', fmtRange(g.summaries)],
      ['系统提示词基准', fmtRange(g.system)],
      ['工具 Schema 定义基准', fmtRange(g.definitions)],
      ['多媒体与文件附件（×引用次数）', fmtRange(audit.attachmentTotal)],
      ['全会话归档内容本地合计', fmtRange(audit.localTotal)]
    ];

    const localKv = $('local-kv');
    if (localKv) {
      localKv.innerHTML = localRows.map(([k, v]) =>
        `<div class="kv-row"><span class="kv-k">${escZh(k)}</span><span class="kv-v">${escZh(v)}</span></div>`
      ).join('');
    }

    const attEl = $('attachments-list');
    const atts = audit.attachments || [];
    if (attEl) {
      if (!atts.length) {
        attEl.innerHTML = `<div class="kv-row"><span class="muted">${escZh('当前会话未检测到图片或文档附件引用')}</span></div>`;
      } else {
        attEl.innerHTML = atts.map((a) => {
          const refTag = (a.references || 1) > 1 ? ` ×${a.references}` : '';
          const dimTag = a.dimensions ? ` · ${a.dimensions}` : '';
          const sizeTag = a.bytes ? ` · ${fmtBytes(a.bytes)}` : '';
          const tokStr = a.status === 'parsed'
            ? (a.low === a.high ? `约 ${fmtInt(a.low)} tok` : `${fmtInt(a.low)}~${fmtInt(a.high)} tok`)
            : `未知（${a.note || '未按 0 计'}）`;
          return (
            `<div class="att-item">` +
            `<div><div class="att-name">${esc(a.name)}${esc(refTag)}</div>` +
            `<div class="att-meta">${escZh(`${a.kind || '文件'}${dimTag}${sizeTag}`)}</div></div>` +
            `<div class="kv-v">${escZh(tokStr)}</div>` +
            `</div>`
          );
        }).join('');
      }
    }
  }

  // -------------------------------------------------------------------------
  // TAB 2: Token History & Interactive Multi-View Charts
  // -------------------------------------------------------------------------

  function renderHistoryPanel(hist) {
    const srcKey = state.sourceFilter;
    const srcMeta = hist.sources?.[srcKey] || hist.sources?.all || {};
    const analytics = hist.analyticsBySource?.[srcKey] || hist.analyticsBySource?.all;
    const dailyMap = hist.dailyMapBySource?.[srcKey] || {};
    if (!analytics) return;

    const s = analytics.summary;
    const cAll = analytics.costs.allTime.hybrid;
    const cMonth = analytics.costs.period.hybrid;
    const todayRec = dailyMap[hist.todayKey] || { total: 0, steps: 0, costUSD: 0, refCostUSD: 0 };
    const todayUSD = todayRec.costUSD > 0 ? todayRec.costUSD : todayRec.refCostUSD;

    // Source meta label
    const cliExtra = srcKey === 'cli' && !hist.sources?.cli?.dirExists ? '（尚未生成 CLI 归档）' : '';
    setText(
      'hist-source-meta',
      `${fmtInt(srcMeta.conversationsCount || 0)} 个会话 · ${fmtInt(srcMeta.transcriptsCount || 0)} 份日志${cliExtra}`
    );

    // 4 KPI Cards
    setText('kpi-total', fmtTokens(s.grandTotalTokens));
    setText('kpi-total-sub', `活跃 ${s.activeDaysCount} 天 · ${fmtInt(s.totalSteps)} 次请求`);
    setText('kpi-total-cost', `折算 ${fmtUSD(cAll.totalCostUSD)}（${fmtCNY(cAll.totalCostUSD)}）`);

    setText('kpi-today', fmtTokens(s.todayTokens));
    setText('kpi-today-sub', `今日 ${fmtInt(todayRec.steps)} 次请求`);
    setText('kpi-today-cost', `折算 ${fmtUSD(todayUSD)}（${fmtCNY(todayUSD)}）`);

    const domDayOfMonth = Math.max(1, Number(hist.todayKey?.slice(8, 10) || 1));
    setText('kpi-month', fmtTokens(s.monthTokens));
    setText('kpi-month-sub', `日均 ${fmtTokens(s.monthTokens / domDayOfMonth, 1)} · 活跃 ${s.monthActiveDays} 天`);
    setText('kpi-month-cost', `折算 ${fmtUSD(cMonth.totalCostUSD)}（${fmtCNY(cMonth.totalCostUSD)}）`);

    // Year cost sum from dailyMap
    const yearPrefix = (hist.todayKey || '').slice(0, 4);
    let yearUSD = 0;
    for (const [d, rec] of Object.entries(dailyMap)) {
      if (d.startsWith(yearPrefix)) {
        yearUSD += rec.costUSD > 0 ? rec.costUSD : rec.refCostUSD;
      }
    }
    setText('kpi-year', fmtTokens(s.yearTokens));
    setText('kpi-year-sub', `${yearPrefix} 年活跃 ${s.yearActiveDays} 天`);
    setText('kpi-year-cost', `折算 ${fmtUSD(yearUSD)}（${fmtCNY(yearUSD)}）`);

    setText('first-use-pill', `首次记录：${hist.firstUseDate || hist.todayKey}`);

    // Render active chart view
    const navRow = $('heat-nav-row');
    if (navRow) navRow.classList.toggle('hidden', state.chartMode !== 'daily');

    if (state.chartMode === 'daily') {
      renderDailyHeatmap(dailyMap, hist);
    } else if (state.chartMode === 'weekly') {
      renderWeeklyBars(dailyMap, hist);
    } else if (state.chartMode === 'monthly') {
      renderMonthlyBars(dailyMap, hist);
    } else if (state.chartMode === 'yearly') {
      renderYearlyBubbles(dailyMap, hist);
    } else if (state.chartMode === 'cumulative') {
      renderCumulativeCurve(dailyMap, hist);
    }
  }

  function parseLocalDate(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  function toYmd(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function computeQuantileThresholds(values) {
    const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b);
    if (!nonZero.length) return [1, 2, 3];
    const pick = (q) => nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * q))];
    return [pick(0.28), pick(0.58), pick(0.84)];
  }

  function levelForValue(val, thresholds) {
    if (!val || val <= 0) return 0;
    if (val <= thresholds[0]) return 1;
    if (val <= thresholds[1]) return 2;
    if (val <= thresholds[2]) return 3;
    return 4;
  }

  function updateInspector(title, rec) {
    const box = $('day-inspector');
    if (!box) return;
    if (!rec || !rec.total) {
      box.innerHTML =
        `<span><strong>${escZh(title)}</strong></span>` +
        `<span class="muted">${escZh('当日 / 区间无 Token 消耗记录')}</span>`;
      return;
    }
    const usd = rec.costUSD > 0 ? rec.costUSD : rec.refCostUSD;
    box.innerHTML =
      `<span><strong>${escZh(title)}</strong> · ${escZh(`总计 ${fmtTokens(rec.total)} (${fmtInt(rec.steps || 0)} 次)`)}</span>` +
      `<span class="muted num">${escZh(`输入 ${fmtTokens(rec.input, 1)} / 缓存 ${fmtTokens(rec.cache, 1)} / 输出 ${fmtTokens(rec.output, 1)} · 约 ${fmtUSD(usd)} (${fmtCNY(usd)})`)}</span>`;
  }

  function updateSummaryRibbon(stats, planStatus, monthsSpan = 1) {
    setText('sum-tok', fmtTokens(stats.totalTokens));
    setText('sum-cost', `${fmtUSD(stats.costUSD)}（${fmtCNY(stats.costUSD)}）`);
    setText('sum-daily', fmtTokens(stats.calendarDays > 0 ? stats.totalTokens / stats.calendarDays : 0, 1));
    setText('sum-active', stats.activeDays > 0 ? fmtTokens(stats.totalTokens / stats.activeDays, 1) : '0');

    const monthlyUSD = planStatus?.monthlyUSD;
    if (monthlyUSD === 0) {
      setText('sum-ratio', `0 实付 · 省 ${fmtUSD(stats.costUSD)}`);
    } else if (monthlyUSD > 0) {
      const denom = monthlyUSD * Math.max(1, monthsSpan);
      const ratio = stats.costUSD / denom;
      setText('sum-ratio', `月费 ${ratio.toFixed(2)}x 等值`);
    } else {
      setText('sum-ratio', '--');
    }
  }

  function renderDailyHeatmap(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;

    const today = parseLocalDate(hist.todayKey);
    const endAnchor = new Date(today);
    endAnchor.setDate(endAnchor.getDate() - state.heatPageOffset * 364);

    // Align end Saturday & start Sunday (53 columns = 371 days covering full 52 weeks)
    const endSat = new Date(endAnchor);
    endSat.setDate(endSat.getDate() + (6 - endSat.getDay()));
    const startSun = new Date(endSat);
    startSun.setDate(startSun.getDate() - 52 * 7 + 1); // Wait: 52*7 - 1 = 363 days (52 weeks * 7 days = 364 days)
    startSun.setDate(endSat.getDate() - (53 * 7 - 1));

    const firstDate = parseLocalDate(hist.firstUseDate || hist.todayKey);
    if ($('btn-heat-prev')) $('btn-heat-prev').disabled = startSun <= firstDate && state.heatPageOffset >= 3;
    if ($('btn-heat-next')) $('btn-heat-next').disabled = state.heatPageOffset <= 0;
    setText('heat-range-label', `${toYmd(startSun)} 至 ${toYmd(endAnchor)}`);

    const windowValues = [];
    const weeks = [];
    const monthLabels = [];
    let lastMonth = -1;

    let rangeTotal = 0;
    let rangeCost = 0;
    let calendarDays = 0;
    let activeDays = 0;

    const cursor = new Date(startSun);
    for (let w = 0; w < 53; w++) {
      const days = [];
      let weekMonthLbl = '';
      for (let d = 0; d < 7; d++) {
        const key = toYmd(cursor);
        const isFuture = cursor > today;
        const rec = dailyMap[key] || null;
        const tot = !isFuture && rec ? rec.total : 0;
        if (!isFuture) {
          windowValues.push(tot);
          calendarDays++;
          if (tot > 0) {
            activeDays++;
            rangeTotal += tot;
            rangeCost += rec.costUSD > 0 ? rec.costUSD : rec.refCostUSD;
          }
        }
        if (d === 0 || cursor.getDate() === 1) {
          const m = cursor.getMonth();
          if (m !== lastMonth) {
            weekMonthLbl = `${m + 1}月`;
            lastMonth = m;
          }
        }
        days.push({ key, isFuture, rec, tot });
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(days);
      monthLabels.push(weekMonthLbl);
    }

    const thresholds = computeQuantileThresholds(windowValues);

    const monthsHtml = monthLabels.map((m) => `<span class="heat-m-lbl">${escZh(m)}</span>`).join('');
    const colsHtml = weeks.map((days) => {
      const cells = days.map((cell) => {
        const lvl = cell.isFuture ? 0 : levelForValue(cell.tot, thresholds);
        const cls = `heat-cell${cell.isFuture ? ' future' : ''}${state.selectedBucketKey === cell.key ? ' selected' : ''}`;
        const tip = cell.isFuture ? cell.key : `${cell.key}：${fmtTokens(cell.tot)}`;
        return `<div class="${cls}" data-lvl="${lvl}" data-day="${cell.key}" title="${escZh(tip)}"></div>`;
      }).join('');
      return `<div class="heat-week">${cells}</div>`;
    }).join('');

    stage.innerHTML =
      `<div class="heatmap-wrap">` +
      `<div class="heat-months-row">${monthsHtml}</div>` +
      `<div class="heat-cols">${colsHtml}</div>` +
      `</div>`;

    // Scroll right to show latest week by default
    if (state.heatPageOffset === 0) {
      requestAnimationFrame(() => { stage.scrollLeft = stage.scrollWidth; });
    }

    stage.querySelectorAll('.heat-cell:not(.future)').forEach((el) => {
      const inspect = (lock) => {
        const k = el.dataset.day;
        if (lock) {
          state.selectedBucketKey = k;
          stage.querySelectorAll('.heat-cell.selected').forEach((n) => n.classList.remove('selected'));
          el.classList.add('selected');
        }
        updateInspector(k, dailyMap[k]);
      };
      el.addEventListener('mouseenter', () => inspect(false));
      el.addEventListener('click', () => inspect(true));
    });

    const inspectKey = state.selectedBucketKey && dailyMap[state.selectedBucketKey]
      ? state.selectedBucketKey
      : hist.todayKey;
    updateInspector(inspectKey, dailyMap[inspectKey]);
    updateSummaryRibbon(
      { totalTokens: rangeTotal, costUSD: rangeCost, calendarDays, activeDays },
      hist.planStatus,
      Math.max(1, Math.round(calendarDays / 30))
    );
  }

  function renderWeeklyBars(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;
    const today = parseLocalDate(hist.todayKey);
    const endSun = new Date(today);
    endSun.setDate(today.getDate() - today.getDay());

    const buckets = [];
    for (let i = 23; i >= 0; i--) {
      const ws = new Date(endSun);
      ws.setDate(endSun.getDate() - i * 7);
      const we = new Date(ws);
      we.setDate(ws.getDate() + 6);
      const agg = { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0 };
      const cur = new Date(ws);
      for (let d = 0; d < 7; d++) {
        if (cur <= today) {
          const rec = dailyMap[toYmd(cur)];
          if (rec) {
            agg.total += rec.total;
            agg.input += rec.input;
            agg.cache += rec.cache;
            agg.output += rec.output;
            agg.steps += rec.steps;
            agg.costUSD += rec.costUSD;
            agg.refCostUSD += rec.refCostUSD;
          }
        }
        cur.setDate(cur.getDate() + 1);
      }
      buckets.push({
        key: `${toYmd(ws)} ~ ${toYmd(we > today ? today : we)}`,
        shortLabel: `${ws.getMonth() + 1}/${ws.getDate()}`,
        agg
      });
    }

    renderBarBuckets(stage, buckets, dailyMap, hist, 6);
  }

  function renderMonthlyBars(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;
    const today = parseLocalDate(hist.todayKey);
    const buckets = [];

    for (let i = 11; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const agg = { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0 };
      for (const [k, rec] of Object.entries(dailyMap)) {
        if (k.startsWith(ym)) {
          agg.total += rec.total;
          agg.input += rec.input;
          agg.cache += rec.cache;
          agg.output += rec.output;
          agg.steps += rec.steps;
          agg.costUSD += rec.costUSD;
          agg.refCostUSD += rec.refCostUSD;
        }
      }
      buckets.push({
        key: `${ym} 自然月`,
        shortLabel: `${d.getMonth() + 1}月`,
        agg
      });
    }

    renderBarBuckets(stage, buckets, dailyMap, hist, 12);
  }

  function renderBarBuckets(stage, buckets, dailyMap, hist, monthsSpan) {
    const maxVal = Math.max(...buckets.map((b) => b.agg.total), 1);
    let sumTok = 0;
    let sumCost = 0;
    for (const b of buckets) {
      sumTok += b.agg.total;
      sumCost += b.agg.costUSD > 0 ? b.agg.costUSD : b.agg.refCostUSD;
    }

    stage.innerHTML = `<div class="bar-chart">${buckets.map((b, idx) => {
      const hPct = b.agg.total > 0 ? Math.max(4, (b.agg.total / maxVal) * 100) : 2;
      const showLbl = buckets.length <= 12 || idx % 2 === 1;
      return (
        `<div class="bar-col${ idx === buckets.length - 1 ? ' selected' : '' }" data-bidx="${idx}" title="${escZh(`${b.key}：${fmtTokens(b.agg.total)}`)}">` +
        `<div class="bar-pillar" style="height:${hPct.toFixed(1)}%"></div>` +
        `<span class="bar-lbl">${showLbl ? escZh(b.shortLabel) : ''}</span>` +
        `</div>`
      );
    }).join('')}</div>`;

    stage.querySelectorAll('.bar-col').forEach((col) => {
      const trigger = (lock) => {
        const b = buckets[Number(col.dataset.bidx)];
        if (!b) return;
        if (lock) {
          stage.querySelectorAll('.bar-col.selected').forEach((n) => n.classList.remove('selected'));
          col.classList.add('selected');
        }
        updateInspector(b.key, b.agg);
      };
      col.addEventListener('mouseenter', () => trigger(false));
      col.addEventListener('click', () => trigger(true));
    });

    const latest = buckets[buckets.length - 1];
    if (latest) updateInspector(latest.key, latest.agg);

    const activeDays = Object.values(dailyMap).filter((v) => v.total > 0).length;
    updateSummaryRibbon(
      { totalTokens: sumTok, costUSD: sumCost, calendarDays: monthsSpan * 30, activeDays },
      hist.planStatus,
      monthsSpan
    );
  }

  function renderYearlyBubbles(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;
    const year = (hist.todayKey || '').slice(0, 4);
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const ym = `${year}-${String(m).padStart(2, '0')}`;
      const agg = { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0 };
      for (const [k, rec] of Object.entries(dailyMap)) {
        if (k.startsWith(ym)) {
          agg.total += rec.total;
          agg.input += rec.input;
          agg.cache += rec.cache;
          agg.output += rec.output;
          agg.steps += rec.steps;
          agg.costUSD += rec.costUSD;
          agg.refCostUSD += rec.refCostUSD;
        }
      }
      months.push({ m, key: `${year} 年 ${m} 月`, agg });
    }

    const maxVal = Math.max(...months.map((x) => x.agg.total), 1);
    let yearTok = 0;
    let yearCost = 0;
    for (const x of months) {
      yearTok += x.agg.total;
      yearCost += x.agg.costUSD > 0 ? x.agg.costUSD : x.agg.refCostUSD;
    }

    stage.innerHTML = `<div class="year-bubbles">${months.map((item, idx) => {
      const size = item.agg.total > 0 ? Math.round(22 + Math.sqrt(item.agg.total / maxVal) * 24) : 18;
      return (
        `<div class="month-bubble-card" data-midx="${idx}">` +
        `<span class="xs muted">${escZh(`${item.m} 月`)}</span>` +
        `<div class="bubble-circle" style="width:${size}px;height:${size}px"></div>` +
        `<strong class="xs num">${esc(item.agg.total > 0 ? fmtTokens(item.agg.total, 1) : '--')}</strong>` +
        `</div>`
      );
    }).join('')}</div>`;

    stage.querySelectorAll('.month-bubble-card').forEach((card) => {
      const handler = () => {
        const item = months[Number(card.dataset.midx)];
        if (item) updateInspector(item.key, item.agg);
      };
      card.addEventListener('mouseenter', handler);
      card.addEventListener('click', handler);
    });

    const curMonthIdx = Math.max(0, Number((hist.todayKey || '').slice(5, 7)) - 1);
    updateInspector(months[curMonthIdx].key, months[curMonthIdx].agg);

    const yearActive = Object.entries(dailyMap).filter(([k, v]) => k.startsWith(year) && v.total > 0).length;
    updateSummaryRibbon(
      { totalTokens: yearTok, costUSD: yearCost, calendarDays: 365, activeDays: yearActive },
      hist.planStatus,
      Math.max(1, curMonthIdx + 1)
    );
  }

  function renderCumulativeCurve(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;
    const start = parseLocalDate(hist.firstUseDate || hist.todayKey);
    const end = parseLocalDate(hist.todayKey);
    const series = [];
    let runningTok = 0;
    let runningCost = 0;
    let activeDays = 0;

    const cur = new Date(start);
    let guard = 0;
    while (cur <= end && guard < 1500) {
      guard++;
      const k = toYmd(cur);
      const rec = dailyMap[k];
      if (rec && rec.total > 0) {
        runningTok += rec.total;
        runningCost += rec.costUSD > 0 ? rec.costUSD : rec.refCostUSD;
        activeDays++;
      }
      series.push({ key: k, cumTokens: runningTok, cumCost: runningCost, dayRec: rec });
      cur.setDate(cur.getDate() + 1);
    }

    if (!series.length) {
      stage.innerHTML = `<div class="muted xs">${escZh('暂无累计曲线数据')}</div>`;
      return;
    }

    const W = 560;
    const H = 132;
    const padX = 10;
    const padY = 12;
    const maxTok = Math.max(runningTok, 1);
    const pts = series.map((s, i) => {
      const x = series.length === 1 ? W / 2 : padX + (i / (series.length - 1)) * (W - padX * 2);
      const y = H - padY - (s.cumTokens / maxTok) * (H - padY * 2);
      return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), ...s };
    });

    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    const area = pts.length > 1
      ? `${line} L${pts[pts.length - 1].x},${H - 4} L${pts[0].x},${H - 4} Z`
      : '';
    const last = pts[pts.length - 1];

    stage.innerHTML =
      `<svg id="cum-svg-el" class="cum-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      `<defs><linearGradient id="cumFill" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="var(--cv-accent)" stop-opacity="0.34"/>` +
      `<stop offset="100%" stop-color="var(--cv-accent)" stop-opacity="0.02"/>` +
      `</linearGradient></defs>` +
      (area ? `<path d="${area}" fill="url(#cumFill)"/>` : '') +
      `<path d="${line}" fill="none" stroke="var(--cv-accent)" stroke-width="2.1" stroke-linecap="round"/>` +
      `<circle id="cum-dot" cx="${last.x}" cy="${last.y}" r="3.5" fill="var(--cv-accent)"/>` +
      `</svg>`;

    const svgEl = $('cum-svg-el');
    const dotEl = $('cum-dot');
    const box = $('day-inspector');
    const showPoint = (pt) => {
      if (!pt || !box) return;
      if (dotEl) {
        dotEl.setAttribute('cx', pt.x);
        dotEl.setAttribute('cy', pt.y);
      }
      const dayTok = pt.dayRec?.total ? `当日 +${fmtTokens(pt.dayRec.total)}` : '当日无新增';
      box.innerHTML =
        `<span><strong>${escZh(`截至 ${pt.key}`)}</strong> · ${escZh(`累计 ${fmtTokens(pt.cumTokens)}`)}</span>` +
        `<span class="muted num">${escZh(`${dayTok} · 累计折算 ${fmtUSD(pt.cumCost)} (${fmtCNY(pt.cumCost)})`)}</span>`;
    };

    showPoint(last);
    if (svgEl) {
      svgEl.addEventListener('mousemove', (ev) => {
        const rect = svgEl.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
        const idx = Math.round(ratio * (pts.length - 1));
        showPoint(pts[idx]);
      });
    }

    updateSummaryRibbon(
      { totalTokens: runningTok, costUSD: runningCost, calendarDays: series.length, activeDays },
      hist.planStatus,
      Math.max(1, Math.ceil(series.length / 30))
    );
  }

  // -------------------------------------------------------------------------
  // TAB 3: Subscription Plan & API Cost Breakdown
  // -------------------------------------------------------------------------

  function populatePlanPresetsIfNeeded(presets) {
    if (state.presetsPopulated || !presets) return;
    const regSel = $('f-region-preset');
    const acqSel = $('f-acquisition');
    const curSel = $('f-currency');
    if (!regSel || !acqSel || !curSel) return;

    regSel.innerHTML = (presets.regions || []).map((r) =>
      `<option value="${esc(r.id)}">${escZh(`${r.name} · ${r.symbol}${r.monthlyPrice}/月`)}</option>`
    ).join('');

    acqSel.innerHTML = (presets.acquisitions || []).map((a) =>
      `<option value="${esc(a.id)}">${escZh(a.name)}</option>`
    ).join('');

    curSel.innerHTML = (presets.currencies || []).map((c) =>
      `<option value="${esc(c.code)}">${esc(`${c.code} (${c.symbol.trim()})`)}</option>`
    ).join('');

    state.presetsPopulated = true;
  }

  function syncPlanFormInputs(planStatus, customPlan = null) {
    if (!planStatus) return;
    const c = customPlan || {};
    if ($('f-region-preset')) $('f-region-preset').value = planStatus.subscriptionRegion || 'US';
    if ($('f-acquisition')) $('f-acquisition').value = planStatus.acquisitionId || 'normal_paid';
    if ($('f-account-country')) $('f-account-country').value = c.accountCountry || '';
    if ($('f-acq-name')) $('f-acq-name').value = c.acquisitionName || '';
    if ($('f-price-mode')) $('f-price-mode').value = planStatus.priceMode || 'preset';
    if ($('f-currency')) $('f-currency').value = planStatus.currency || 'USD';
    if ($('f-paid')) {
      $('f-paid').value = c.actualPricePaid !== undefined && c.actualPricePaid !== null
        ? c.actualPricePaid
        : (planStatus.effectivePrice ?? '');
    }
    if ($('f-cycle')) $('f-cycle').value = planStatus.billingCycle || '月付';
    if ($('f-valid-until')) $('f-valid-until').value = planStatus.validUntil || '';
    if ($('f-zero-extra')) $('f-zero-extra').checked = Boolean(planStatus.zeroExtra);
    if ($('f-note')) $('f-note').value = planStatus.note || '';
  }

  function renderCostPanel(hist) {
    const plan = hist.planStatus || {};
    const quotas = hist.modelQuotas || [];

    // Badge
    const badge = $('plan-tier-badge');
    if (badge) {
      badge.className = `status-pill ${plan.status === 'identified' ? 'good' : 'neutral'}`;
      setText(badge, plan.isCustomized ? '已自定义实付' : (plan.status === 'identified' ? '自动识别' : '待补充'));
    }

    setText('plan-headline', plan.tierName || '未识别订阅');
    setText('plan-subline', `${plan.subscriptionRegionName || '默认美区'} · ${plan.acquisitionLabel || '常规订阅'}`);

    if (plan.monthlyNormalized === 0) {
      setText('plan-price-main', `${plan.symbol || '$'}0 / 月`);
      setText('plan-price-cny', '免额外订阅费（¥0.00）');
    } else if (plan.monthlyNormalized !== null && plan.monthlyNormalized !== undefined) {
      setText('plan-price-main', `${plan.symbol || '$'}${plan.monthlyNormalized} / 月`);
      setText('plan-price-cny', `折合人民币约 ¥${(plan.monthlyCNY ?? 0).toFixed(2)} / 月`);
    } else {
      setText('plan-price-main', '待指定金额');
      setText('plan-price-cny', plan.priceRangeNote || '--');
    }

    const fmtCredit = (c) => {
      if (!c || (c.available === null && c.monthly === null)) return '--';
      if (c.available !== null && c.monthly !== null) return `${fmtInt(c.available)} / ${fmtInt(c.monthly)}`;
      return fmtInt(c.available ?? c.monthly);
    };

    const planRows = [
      ['当前账号（脱敏）', plan.maskedEmail || '本机已登录会话'],
      ['计价地区与周期', `${plan.subscriptionRegionName || '--'} · ${plan.billingCycle || '月付'}`],
      ['权益获取渠道', plan.acquisitionLabel || '--'],
      ['Prompt Credits（可用 / 月度）', fmtCredit(plan.promptCredits)],
      ['Flow Credits（可用 / 月度）', fmtCredit(plan.flowCredits)]
    ];
    if (plan.accountCountry && plan.accountCountry !== '自动 / 未设置') {
      planRows.push(['账号归属地备注', plan.accountCountry]);
    }
    if (plan.validUntil) planRows.push(['权益到期日', plan.validUntil]);
    if (plan.note) planRows.push(['本地备注', plan.note]);

    const planKv = $('plan-kv');
    if (planKv) {
      planKv.innerHTML = planRows.map(([k, v]) =>
        `<div class="kv-row"><span class="kv-k">${escZh(k)}</span><span class="kv-v">${escZh(v)}</span></div>`
      ).join('');
    }

    // Live Model Quota Pools
    const qWrap = $('quota-pools-wrap');
    const qList = $('quota-pools-list');
    if (qWrap && qList) {
      if (quotas.length > 0) {
        qWrap.classList.remove('hidden');
        qList.innerHTML = quotas.map((pool) => {
          const pct = pool.remainingPercent ?? 100;
          const col = pct <= 15 ? 'var(--danger)' : pct <= 40 ? 'var(--warn)' : 'var(--good)';
          const label = (pool.models || []).slice(0, 3).join(' / ');
          const extra = (pool.models?.length || 0) > 3 ? ` 等 ${pool.models.length} 个模型` : '';
          const resetStr = pool.resetTimeZh ? ` · ${pool.resetTimeZh}重置` : '';
          return (
            `<div class="quota-inline">` +
            `<div class="quota-inline-head">` +
            `<span class="quota-name">${escZh(`${label}${extra}`)}</span>` +
            `<span class="num-strong">${escZh(`${pct.toFixed(1)}%${resetStr}`)}</span>` +
            `</div>` +
            `<div class="thin-track"><div class="thin-fill" style="width:${Math.min(100, Math.max(0, pct))}%;background:${col}"></div></div>` +
            `</div>`
          );
        }).join('');
      } else {
        qWrap.classList.add('hidden');
      }
    }

    // Card 2: API Cost Breakdown & Subscription Comparison
    const srcAnalytics = hist.analyticsBySource?.[state.sourceFilter] || hist.analyticsBySource?.all;
    if (!srcAnalytics) return;

    const scopeBundle = srcAnalytics.costs?.[state.costScope] || srcAnalytics.costs?.period;
    const ident = scopeBundle.identified;
    const ref = scopeBundle.reference;
    const hyb = scopeBundle.hybrid;

    let totalUSD = 0;
    let inUSD = 0;
    let cacheUSD = 0;
    let outUSD = 0;
    let inTok = ref.inputTokens;
    let cacheTok = ref.cacheTokens;
    let outTok = ref.outputTokens;

    if (state.costMode === 'hybrid') {
      totalUSD = hyb.totalCostUSD;
      inUSD = hyb.inputCostUSD;
      cacheUSD = hyb.cacheCostUSD;
      outUSD = hyb.outputCostUSD;
    } else if (state.costMode === 'identified') {
      totalUSD = ident.pricedCostUSD;
      inUSD = ident.pricedInputCostUSD;
      cacheUSD = ident.pricedCacheCostUSD;
      outUSD = ident.pricedOutputCostUSD;
      inTok = ident.byCategory.inputTokens;
      cacheTok = ident.byCategory.cacheTokens;
      outTok = ident.byCategory.outputTokens;
    } else {
      totalUSD = ref.totalCostUSD;
      inUSD = ref.inputCostUSD;
      cacheUSD = ref.cacheCostUSD;
      outUSD = ref.outputCostUSD;
    }

    setText('cost-big-usd', fmtUSD(totalUSD));
    setText('cost-big-cny', `折合人民币约 ${fmtCNY(totalUSD)}`);

    const covPill = $('cost-cov-pill');
    if (covPill) {
      const cov = ident.tokenCoveragePercent ?? 100;
      covPill.className = `status-pill ${cov >= 85 ? 'good' : cov >= 45 ? 'warn' : 'neutral'}`;
      setText(
        covPill,
        state.costMode === 'reference' ? 'Flash 统一基准' : `已精确识别 ${cov.toFixed(1)}% Token`
      );
    }
    setText(
      'cost-scope-label',
      state.costScope === 'period'
        ? `${hist.currentPeriod?.label || '本期自然月'} · ${fmtInt(ident.totalRequestsCount)} 次请求`
        : `自 ${hist.firstUseDate || '--'} 累计 · ${fmtInt(ident.totalRequestsCount)} 次请求`
    );

    // Dual bar comparison: API value vs Subscription actual paid
    const dailyMap = hist.dailyMapBySource?.[state.sourceFilter] || {};
    const activeMonthsCount = state.costScope === 'period'
      ? 1
      : Math.max(1, new Set(Object.keys(dailyMap).map((d) => d.slice(0, 7))).size);

    const subUSD = plan.monthlyUSD !== null && plan.monthlyUSD !== undefined
      ? Number((plan.monthlyUSD * activeMonthsCount).toFixed(2))
      : null;

    setText(
      'compare-title',
      state.costScope === 'period'
        ? '本月 API 等值消耗 vs 月度订阅实付'
        : `全量 API 等值消耗 vs 累计订阅实付（按 ${activeMonthsCount} 个活跃月折算）`
    );

    const maxBar = Math.max(totalUSD, subUSD || 0, 0.01);
    if ($('bar-api-val')) $('bar-api-val').style.width = `${Math.min(100, (totalUSD / maxBar) * 100).toFixed(1)}%`;
    setText('lbl-api-val', fmtUSD(totalUSD));

    if (subUSD !== null) {
      if ($('bar-sub-val')) $('bar-sub-val').style.width = `${Math.min(100, (subUSD / maxBar) * 100).toFixed(1)}%`;
      setText('lbl-sub-val', fmtUSD(subUSD));
      const diff = totalUSD - subUSD;
      if (subUSD === 0) {
        setText('compare-diff', `免额外付费 · 已白嫖等值 ${fmtUSD(totalUSD)}`);
      } else if (diff >= 0) {
        setText('compare-diff', `已超出订阅费 +${fmtUSD(diff)}（${(totalUSD / subUSD).toFixed(2)}x 回本）`);
      } else {
        setText('compare-diff', `距回本还差 ${fmtUSD(Math.abs(diff))}（已用 ${(totalUSD / subUSD * 100).toFixed(0)}%）`);
      }
    } else {
      if ($('bar-sub-val')) $('bar-sub-val').style.width = '0%';
      setText('lbl-sub-val', '未设实付');
      setText('compare-diff', '设置订阅实付后可对比性价比');
    }

    // 3 Category Tiles
    setText('cat-in-cost', fmtUSD(inUSD));
    setText('cat-in-tok', `${fmtTokens(inTok)} tok`);
    setText('cat-cache-cost', fmtUSD(cacheUSD));
    setText('cat-cache-tok', `${fmtTokens(cacheTok)} tok`);
    setText('cat-out-cost', fmtUSD(outUSD));
    setText('cat-out-tok', `${fmtTokens(outTok)} tok`);

    // Model Leaderboard
    const board = $('model-leaderboard');
    if (board) {
      const models = ident.byModel || [];
      if (!models.length) {
        board.innerHTML = `<div class="kv-row"><span class="muted">${escZh('当前统计范围内暂无模型请求记录')}</span></div>`;
      } else {
        const maxModelTok = Math.max(...models.map((m) => m.tokens || 0), 1);
        board.innerHTML = models.map((m) => {
          const wPct = Math.max(2, ((m.tokens || 0) / maxModelTok) * 100).toFixed(1);
          const costLabel = m.unpriced
            ? `未记模型（混合模式下按基准折算）`
            : `${fmtUSD(m.costUSD)}（${fmtCNY(m.costUSD)}）`;
          return (
            `<div class="model-row">` +
            `<div class="model-row-top">` +
            `<span class="model-name">${escZh(m.displayName)}</span>` +
            `<span class="num-strong">${escZh(costLabel)}</span>` +
            `</div>` +
            `<div class="thin-track"><div class="thin-fill accent" style="width:${wPct}%"></div></div>` +
            `<div class="model-row-sub">` +
            `<span>${escZh(`${fmtInt(m.requests)} 次请求 · 总计 ${fmtTokens(m.tokens)}`)}</span>` +
            `<span class="num">${escZh(`入 ${fmtTokens(m.inputTokens, 1)} / 缓 ${fmtTokens(m.cacheTokens, 1)} / 出 ${fmtTokens(m.outputTokens, 1)}`)}</span>` +
            `</div>` +
            `</div>`
          );
        }).join('');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event Wiring & Lifecycle
  // -------------------------------------------------------------------------

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.main-tab').forEach((btn) => {
      const active = btn.dataset.tab === tabName;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `panel-${tabName}`);
    });
  }

  function wireEvents() {
    // Primary tabs & capsule shortcuts
    document.querySelectorAll('.main-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    document.querySelectorAll('[data-goto-tab]').forEach((pill) => {
      pill.addEventListener('click', () => switchTab(pill.dataset.gotoTab));
    });

    // Collapsible sections
    document.querySelectorAll('.collapse-trigger').forEach((btn) => {
      btn.addEventListener('click', () => {
        const body = $(btn.dataset.toggle);
        if (!body) return;
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        body.classList.toggle('hidden', expanded);
      });
    });

    // Conversation selector & follow-current button
    $('conv-select')?.addEventListener('change', (e) => {
      state.selectedConvId = e.target.value || '';
      state.contextEtag = '';
      $('btn-follow-current')?.classList.toggle('hidden', !state.selectedConvId);
      apiFetch('/api/entrypoints', {
        method: 'POST',
        body: { pinnedConvId: state.selectedConvId }
      }).catch(() => {});
      loadContext(true).catch(() => {});
    });

    $('btn-follow-current')?.addEventListener('click', () => {
      state.selectedConvId = '';
      if ($('conv-select')) $('conv-select').value = '';
      $('btn-follow-current')?.classList.add('hidden');
      state.contextEtag = '';
      apiFetch('/api/entrypoints', {
        method: 'POST',
        body: { pinnedConvId: '' }
      }).catch(() => {});
      loadContext(true).catch(() => {});
      showToast('已切回自动跟随当前对话');
    });

    // When user clicks inside an Aux Pane bound to a specific host conversation, notify Menu Bar
    if (!window.__CV_FLOAT_MODE__) {
      let lastFocusSentAt = 0;
      document.addEventListener('pointerdown', () => {
        const hostId = window.sidecar?.conversationId || state.hostConvId || '';
        const now = Date.now();
        if (!hostId || state.selectedConvId || now - lastFocusSentAt < 2500) return;
        lastFocusSentAt = now;
        apiFetch('/api/entrypoints', {
          method: 'POST',
          body: { activeHostConvId: hostId }
        }).catch(() => {});
      }, { passive: true });
    }

    // Context budget limit override buttons (Auto / 200K / 256K / 1M)
    document.querySelectorAll('#budget-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.ui.budgetOverride = Number(btn.dataset.budget || 0);
        document.querySelectorAll('#budget-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        persistUiPreferences();
        if (state.contextData) {
          renderContextPanel(state.contextData);
          renderTopCapsules();
        }
      });
    });

    // Per-turn timeline filter buttons
    document.querySelectorAll('#turns-filter-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.turnsFilter = btn.dataset.tfilter || 'all';
        document.querySelectorAll('#turns-filter-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        if (state.contextData) {
          renderTurnsTimelineCard(state.contextData.turns || [], state.contextData.audit?.turnsCount || 0);
        }
      });
    });

    // Refresh & Rescan
    const triggerForceRefresh = async (ev) => {
      if (ev?.shiftKey) {
        if (window.__CV_FLOAT_MODE__ && !window.__CV_BROWSER_FALLBACK__) {
          await apiFetch('/api/reload-float-bundle', { method: 'POST' }).catch(() => {});
          return;
        }
        window.location.reload();
        return;
      }
      if (!window.__CV_FLOAT_MODE__ || window.__CV_BROWSER_FALLBACK__) {
        const cssLink = document.querySelector('link[href^="/styles.css"]');
        if (cssLink) cssLink.href = `/styles.css?v=${Date.now()}`;
      }
      applyAppearanceToDom();
      const icon = $('ic-refresh');
      icon?.classList.add('spin');
      try {
        await Promise.all([loadContext(true), loadHistory(true), refreshFloatStatus()]);
        showToast('已同步最新会话上下文与全量统计');
      } catch (err) {
        showToast(`刷新失败：${err.message}`);
      } finally {
        setTimeout(() => icon?.classList.remove('spin'), 350);
      }
    };
    $('btn-refresh')?.addEventListener('click', triggerForceRefresh);
    $('btn-rescan-files')?.addEventListener('click', triggerForceRefresh);

    // Detached Right-Side Floating Window (`📌`)
    $('btn-float')?.addEventListener('click', async (ev) => {
      if (window.__CV_FLOAT_MODE__) {
        if (ev.shiftKey || window.__CV_BROWSER_FALLBACK__) {
          if (window.sidecar?.closeFloatWindow) {
            window.sidecar.closeFloatWindow();
          } else {
            await apiFetch('/api/float-window', { method: 'POST', body: { action: 'close' } }).catch(() => {});
          }
          return;
        }
        const next = !state.floatPinned;
        state.floatPinned = next;
        window.sidecar?.setPinned?.(next);
        syncFloatButtonUi();
        showToast(next ? '已重新钉在屏幕最前' : '已取消置顶（现为普通窗口，点击左上角红叉可关闭）');
        return;
      }

      try {
        const res = await apiFetch('/api/float-window', {
          method: 'POST',
          body: { action: 'toggle' }
        });
        if (!res.ok) {
          showToast(res.error || '独立看板操作失败');
          return;
        }
        state.floatRunning = Boolean(res.running);
        state.floatPinned = Boolean(res.pinned);
        syncFloatButtonUi();
        showToast(res.message || (res.running ? '已在屏幕右侧打开独立看板' : '已关闭右侧独立看板'));
      } catch (err) {
        showToast(`操作独立看板失败：${err.message}`);
      }
    });

    // CLI Launcher
    $('btn-cli')?.addEventListener('click', async () => {
      try {
        const res = await apiFetch('/api/launch-cli', {
          method: 'POST',
          body: {
            workspaceUri: state.workspaceUri || '',
            workspacePath: state.contextData?.workspacePath || ''
          }
        });
        showToast(res.ok ? res.message : (res.error || '唤起终端失败'));
      } catch (err) {
        showToast(`唤起终端失败：${err.message}`);
      }
    });

    // Palette drawer & quick theme cycle
    const drawer = $('palette-drawer');
    $('btn-palette')?.addEventListener('click', () => {
      if (!drawer) return;
      const willOpen = drawer.classList.contains('hidden');
      drawer.classList.toggle('hidden', !willOpen);
      $('btn-palette')?.setAttribute('aria-expanded', String(willOpen));
    });
    $('btn-close-palette')?.addEventListener('click', () => {
      drawer?.classList.add('hidden');
      $('btn-palette')?.setAttribute('aria-expanded', 'false');
    });

    // Persistent Top Menu Bar (`◈` / `⚡` / `⏳`) & Right Floating Window (`📌`) switches
    document.querySelectorAll('#menubar-entry-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const wantOn = btn.dataset.menubarEntry === 'on';
        try {
          const res = await apiFetch('/api/entrypoints', {
            method: 'POST',
            body: { menubarEnabled: wantOn }
          });
          if (!res.ok) {
            showToast(res.error || '切换顶部菜单栏常驻图标失败');
            return;
          }
          state.menubarEnabled = Boolean(res.menubarEnabled);
          if (res.menubarMode) state.menubarMode = res.menubarMode;
          syncFloatButtonUi();
          showToast(res.message || (state.menubarEnabled ? '已开启顶部菜单栏常驻图标' : '已关闭顶部菜单栏常驻图标'));
        } catch (err) {
          showToast(`切换失败：${err.message}`);
        }
      });
    });

    document.querySelectorAll('#menubar-mode-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const nextMode = btn.dataset.menubarMode || 'context';
        try {
          const res = await apiFetch('/api/entrypoints', {
            method: 'POST',
            body: { menubarMode: nextMode }
          });
          if (!res.ok) {
            showToast(res.error || '切换菜单栏显示内容失败');
            return;
          }
          state.menubarMode = res.menubarMode || nextMode;
          if (typeof res.menubarEnabled === 'boolean') {
            state.menubarEnabled = res.menubarEnabled;
          }
          syncFloatButtonUi();
          showToast(res.message || '已更新顶部菜单栏显示内容');
        } catch (err) {
          showToast(`切换失败：${err.message}`);
        }
      });
    });

    $('btn-drawer-float')?.addEventListener('click', () => {
      $('btn-float')?.click();
    });

    $('btn-theme')?.addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(state.ui.themeMode) + 1) % order.length];
      state.ui.themeMode = next;
      applyAppearanceToDom();
      persistUiPreferences();
      const labels = { auto: '跟随宿主主题', light: '浅色主题', dark: '深色主题' };
      showToast(`已切换为${labels[next]}`);
    });

    document.querySelectorAll('#theme-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.ui.themeMode = btn.dataset.themeMode;
        applyAppearanceToDom();
        persistUiPreferences();
      });
    });

    document.querySelectorAll('#heat-presets .preset-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        state.ui.preset = chip.dataset.preset;
        state.ui.customLevels = null;
        state.ui.customAccent = '';
        applyAppearanceToDom();
        persistUiPreferences();
      });
    });

    for (let i = 0; i < 5; i++) {
      $(`col-lvl${i}`)?.addEventListener('input', (ev) => {
        const dark = isEffectiveDark();
        const presetObj = HEAT_PRESETS[state.ui.preset] || HEAT_PRESETS.violet;
        const base = [...(state.ui.customLevels || (dark ? presetObj.dark : presetObj.light))];
        base[i] = ev.target.value;
        state.ui.customLevels = base;
        applyAppearanceToDom();
        persistUiPreferences();
      });
    }
    $('col-accent')?.addEventListener('input', (ev) => {
      state.ui.customAccent = ev.target.value;
      applyAppearanceToDom();
      persistUiPreferences();
    });

    $('btn-reset-appearance')?.addEventListener('click', () => {
      state.ui = { themeMode: 'auto', preset: 'violet', customLevels: null, customAccent: '', budgetOverride: 0 };
      applyAppearanceToDom();
      persistUiPreferences();
      if (state.contextData) {
        renderContextPanel(state.contextData);
        renderTopCapsules();
      }
      showToast('已恢复默认外观与色阶');
    });

    // Legend box click -> open palette & trigger corresponding color input
    document.querySelectorAll('#heat-legend .leg-box').forEach((box) => {
      box.addEventListener('click', () => {
        const slot = box.dataset.legSlot;
        drawer?.classList.remove('hidden');
        $(`col-lvl${slot}`)?.click();
      });
    });

    // History source & chart mode switches
    document.querySelectorAll('#source-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.sourceFilter = btn.dataset.source;
        document.querySelectorAll('#source-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        if (state.historyData) {
          renderHistoryPanel(state.historyData);
          renderCostPanel(state.historyData);
          renderTopCapsules();
        }
      });
    });

    document.querySelectorAll('#chart-mode-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.chartMode = btn.dataset.chart;
        document.querySelectorAll('#chart-mode-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        if (state.historyData) renderHistoryPanel(state.historyData);
      });
    });

    $('btn-heat-prev')?.addEventListener('click', () => {
      state.heatPageOffset += 1;
      if (state.historyData) renderHistoryPanel(state.historyData);
    });
    $('btn-heat-next')?.addEventListener('click', () => {
      state.heatPageOffset = Math.max(0, state.heatPageOffset - 1);
      if (state.historyData) renderHistoryPanel(state.historyData);
    });

    // Cost scope & mode switches
    document.querySelectorAll('#cost-scope-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.costScope = btn.dataset.scope;
        document.querySelectorAll('#cost-scope-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        if (state.historyData) renderCostPanel(state.historyData);
      });
    });

    document.querySelectorAll('#cost-mode-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.costMode = btn.dataset.cmode;
        document.querySelectorAll('#cost-mode-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        if (state.historyData) renderCostPanel(state.historyData);
      });
    });

    // Subscription Plan Form
    const planForm = $('plan-form');
    $('btn-toggle-plan-form')?.addEventListener('click', () => {
      if (!planForm) return;
      const opening = planForm.classList.contains('hidden');
      if (opening && state.historyData?.planStatus) {
        syncPlanFormInputs(state.historyData.planStatus, state.settingsData?.customPlan);
      }
      planForm.classList.toggle('hidden', !opening);
    });
    $('btn-cancel-plan')?.addEventListener('click', () => {
      planForm?.classList.add('hidden');
    });

    $('f-region-preset')?.addEventListener('change', (ev) => {
      const regions = state.historyData?.presets?.regions || state.settingsData?.presets?.regions || [];
      const found = regions.find((r) => r.id === ev.target.value);
      if (found) {
        if ($('f-currency')) $('f-currency').value = found.currency;
        if ($('f-price-mode')?.value === 'preset' && $('f-paid')) {
          $('f-paid').value = found.monthlyPrice;
        }
      }
    });

    $('f-acquisition')?.addEventListener('change', (ev) => {
      const acqs = state.historyData?.presets?.acquisitions || state.settingsData?.presets?.acquisitions || [];
      const found = acqs.find((a) => a.id === ev.target.value);
      if (found && found.defaultPaid === 0 && $('f-zero-extra')) {
        $('f-zero-extra').checked = true;
      }
    });

    planForm?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const customPlan = {
          subscriptionRegion: $('f-region-preset')?.value || 'US',
          acquisitionId: $('f-acquisition')?.value || 'normal_paid',
          accountCountry: $('f-account-country')?.value?.trim() || '',
          acquisitionName: $('f-acq-name')?.value?.trim() || '',
          priceMode: $('f-price-mode')?.value || 'preset',
          currency: $('f-currency')?.value || 'USD',
          actualPricePaid: $('f-paid')?.value !== '' ? Number($('f-paid').value) : null,
          billingCycle: $('f-cycle')?.value || '月付',
          validUntil: $('f-valid-until')?.value || '',
          zeroExtra: Boolean($('f-zero-extra')?.checked),
          note: $('f-note')?.value?.trim() || ''
        };
        const saved = await apiFetch('/api/settings', { method: 'POST', body: { customPlan } });
        state.settingsData = saved;
        planForm.classList.add('hidden');
        await loadHistory(true);
        showToast('已保存订阅与实付设置');
      } catch (err) {
        showToast(`保存失败：${err.message}`);
      }
    });

    $('btn-clear-plan')?.addEventListener('click', async () => {
      try {
        const saved = await apiFetch('/api/settings', { method: 'POST', body: { clearPlan: true } });
        state.settingsData = saved;
        planForm?.classList.add('hidden');
        await loadHistory(true);
        showToast('已恢复自动订阅识别');
      } catch (err) {
        showToast(`重置失败：${err.message}`);
      }
    });

    // Observe host theme inline style mutations injected by sidecar_sdk preload.js
    const styleObserver = new MutationObserver(() => {
      if (state.ui.themeMode === 'auto') applyAppearanceToDom();
    });
    styleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
      if (state.ui.themeMode === 'auto') applyAppearanceToDom();
    });
  }

  function syncFloatButtonUi() {
    const menubarRow = $('menubar-entry-row');
    if (menubarRow) {
      menubarRow.classList.toggle('hidden', state.menubarSupported === false);
    }
    const menubarModeRow = $('menubar-mode-row');
    if (menubarModeRow) {
      menubarModeRow.classList.toggle('hidden', state.menubarSupported === false);
    }
    document.querySelectorAll('#menubar-entry-seg .seg-btn').forEach((b) => {
      const active = (b.dataset.menubarEntry === 'on') === Boolean(state.menubarEnabled);
      b.classList.toggle('active', active);
    });
    document.querySelectorAll('#menubar-mode-seg .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.menubarMode === (state.menubarMode || 'context'));
    });

    const drawerFloatBtn = $('btn-drawer-float');
    if (drawerFloatBtn) {
      if (window.__CV_FLOAT_MODE__) {
        setText(
          drawerFloatBtn,
          window.__CV_BROWSER_FALLBACK__
            ? '关闭当前小窗'
            : (state.floatPinned ? '当前在小窗中 · 点击取消置顶' : '当前在小窗中 · 点击恢复置顶')
        );
      } else {
        setText(drawerFloatBtn, state.floatRunning ? '运行中 · 点击收回小窗' : '弹出独立置顶小窗');
      }
    }

    const btn = $('btn-float');
    if (!btn) return;
    if (window.__CV_FLOAT_MODE__) {
      const pinned = Boolean(state.floatPinned) && !window.__CV_BROWSER_FALLBACK__;
      btn.classList.toggle('pin-active', pinned);
      const tip = window.__CV_BROWSER_FALLBACK__
        ? formatZh('关闭右侧独立看板小窗')
        : pinned
          ? formatZh('当前：已钉在屏幕最前（点击取消置顶；Shift+点击收回小窗）')
          : formatZh('当前：已取消置顶（点击重新钉在最前；Shift+点击收回小窗）');
      btn.title = tip;
      btn.setAttribute('aria-label', tip);
    } else {
      const active = Boolean(state.floatRunning);
      btn.classList.toggle('pin-active', active);
      const tip = active
        ? formatZh('右侧独立置顶看板显示中（点击收回小窗）')
        : formatZh('钉在屏幕右侧独立置顶小窗（不受右侧栏切换影响，随时可取消）');
      btn.title = tip;
      btn.setAttribute('aria-label', tip);
    }
  }

  async function refreshFloatStatus() {
    try {
      const res = await apiFetch('/api/entrypoints');
      if (typeof res.menubarSupported === 'boolean') {
        state.menubarSupported = res.menubarSupported;
      }
      if (typeof res.menubarEnabled === 'boolean') {
        state.menubarEnabled = res.menubarEnabled;
      }
      if (typeof res.menubarMode === 'string' && res.menubarMode) {
        state.menubarMode = res.menubarMode;
      }
      if (!window.__CV_FLOAT_MODE__ && res.floatWindow) {
        state.floatRunning = Boolean(res.floatWindow.running);
        state.floatPinned = Boolean(res.floatWindow.pinned);
      }
      syncFloatButtonUi();
    } catch {}
  }

  window.__cvOnHostPinChange = (pinned) => {
    state.floatPinned = Boolean(pinned);
    syncFloatButtonUi();
  };

  window.__cvOnHostMenubarChange = (enabled) => {
    state.menubarEnabled = Boolean(enabled);
    syncFloatButtonUi();
  };

  window.__cvOnHostMenubarModeChange = (mode) => {
    if (mode) state.menubarMode = String(mode);
    syncFloatButtonUi();
  };

  window.__cvOnHostVisibility = (visible) => {
    const vis = Boolean(visible);
    state.hostHidden = !vis;
    if (vis) {
      loadContext(false).catch(() => {});
      loadHistory(false).catch(() => {});
      refreshFloatStatus().catch(() => {});
    }
  };

  async function initWorkspaceTracking() {
    if (!window.sidecar) return;
    try {
      const uris = await window.sidecar.getWorkspaceUris?.();
      if (Array.isArray(uris) && uris[0]) state.workspaceUri = uris[0];
    } catch {}
    try {
      window.sidecar.onWorkspaceChange?.((uris) => {
        if (Array.isArray(uris) && uris[0]) state.workspaceUri = uris[0];
      });
    } catch {}
  }

  async function boot() {
    normalizeStaticDomTypography();
    applyAppearanceToDom();
    syncFloatButtonUi();
    wireEvents();
    initWorkspaceTracking();

    await Promise.allSettled([
      loadInitialSettings(),
      loadContext(false),
      loadHistory(false),
      refreshFloatStatus()
    ]);

    // Snappy ETag-backed background polling while panel is visible
    setInterval(() => {
      if (document.hidden || state.hostHidden) return;
      loadContext(false).catch(() => {});
    }, 1500);

    setInterval(() => {
      if (document.hidden || state.hostHidden) return;
      loadHistory(false).catch(() => {});
      refreshFloatStatus().catch(() => {});
    }, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
