#!/usr/bin/env node
/**
 * Cross-platform Terminal Dashboard & CLI Helper for Antigravity Context Viewer.
 *
 * Works seamlessly for both Antigravity Desktop (`agy` App) and `agy` CLI users:
 *   node cli.mjs                  # Pretty ANSI terminal dashboard summary
 *   node cli.mjs status [convId]  # Pretty summary for latest or specified session
 *   node cli.mjs turns [convId]   # Per-turn context delta & tool call timeline
 *   node cli.mjs json [convId]    # Compact JSON summary (add --full for raw payload)
 *   node cli.mjs float [close]    # Open / toggle / close right-side pinned floating window (Option B)
 *   node cli.mjs sidebar [on|off] # Enable / disable / toggle left-sidebar persistent tab (Option A)
 *   node cli.mjs web [--port N]   # Launch standalone Web UI in default browser
 */

import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectTokenHistory,
  getMenubarMode,
  getSidebarEntryStatus,
  MENUBAR_MODES,
  scanConversation,
  setSidebarEntrypoint,
  syncSidebarManifestFromSettings
} from './collector.mjs';
import { controlFloatWindow, getFloatWindowStatus } from './float_window.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const PLUGIN_DIR_ID = basename(PLUGIN_ROOT);

const useColor = Boolean((process.stdout.isTTY || process.env.FORCE_COLOR) && !process.env.NO_COLOR);
const c = {
  reset: useColor ? '\x1b[0m' : '',
  bold: useColor ? '\x1b[1m' : '',
  dim: useColor ? '\x1b[2m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  magenta: useColor ? '\x1b[35m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red: useColor ? '\x1b[31m' : ''
};

/**
 * Deterministic CJK + Latin/Digit spacing & dash normalizer (preserves ANSI escape codes).
 */
function formatZh(input) {
  if (input === null || input === undefined) return '';
  const ansiMasks = [];
  let s = String(input).replace(/\x1b\[[0-9;]*m/g, (m) => {
    ansiMasks.push(m);
    return `\u0000A${ansiMasks.length - 1}\u0000`;
  });
  s = s.replace(/——/g, ' -- ');
  s = s.replace(/([\u4e00-\u9fff])([A-Za-z0-9$¥€£@#%/+-])/g, '$1 $2');
  s = s.replace(/([A-Za-z0-9%$¥€£])([\u4e00-\u9fff])/g, '$1 $2');
  return s.replace(/\u0000A(\d+)\u0000/g, (_, idx) => ansiMasks[Number(idx)] || '');
}

function fmtTok(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '--';
  const num = Number(n);
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (Math.abs(num) >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(Math.round(num));
}

function fmtUsd(n, digits = 2) {
  const num = Number(n || 0);
  return `$${num.toFixed(digits)}`;
}

function renderBar(pct, width = 20, invertWarn = false) {
  const clamped = Math.max(0, Math.min(100, Number(pct || 0)));
  const filled = Math.round((clamped / 100) * width);
  const barStr = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
  let col = c.green;
  if (invertWarn) {
    col = clamped <= 15 ? c.red : clamped <= 40 ? c.yellow : c.green;
  } else {
    col = clamped >= 90 ? c.red : clamped >= 75 ? c.yellow : c.green;
  }
  return `${col}[${barStr}]${c.reset}`;
}

function normalizeMenubarModeArg(raw) {
  const s = String(raw || '').toLowerCase();
  if (['context', 'ctx', 'percent', 'pct'].includes(s)) return 'context';
  if (['speed', 'spd', 'tps', 'latency'].includes(s)) return 'speed';
  if (['quota', '5h', 'week', 'limit'].includes(s)) return 'quota';
  return null;
}

function printHelp() {
  const lines = [
    `${c.bold}Antigravity Context & Token Viewer CLI (v1.6.1)${c.reset}`,
    '',
    '用法：',
    '  agy-context [status] [conversationId]           终端可视化汇总（自动识别桌面端与 agy CLI 最新活跃会话）',
    '  agy-context menubar [context|speed|quota]       定制 macOS 顶部菜单栏显示：上下文占比 / 速度与耗时 / 5h或Week额度',
    '  agy-context menubar [on|off|toggle|status]      开启、关闭或查看顶部菜单栏常驻图标（切换会话时自动跟随）',
    '  agy-context float [toggle|close|quit]           切换屏幕右侧独立置顶小窗（不受右侧栏切换影响，随时可取消置顶或收回）',
    '  agy-context turns [conversationId]              查看最近 20 轮每轮上下文涨跌 (±Delta) 与工具调用明细',
    '  agy-context json [conversationId]               输出结构化 JSON 摘要（加 --full 输出完整原始快照）',
    '  agy-context web [--port 18970]                  启动独立本地 Web 看板并自动在浏览器打开（适合纯 CLI 用户）',
    '  agy-context --help                              查看帮助说明'
  ];
  console.log(lines.map(formatZh).join('\n'));
}

async function runMenubarCommand(rawArgs) {
  const sub = (rawArgs.filter((a) => !a.startsWith('-'))[1] || 'toggle').toLowerCase();
  if (rawArgs.includes('--status') || sub === 'status') {
    const st = getFloatWindowStatus();
    if (rawArgs.includes('--json')) {
      console.log(JSON.stringify(st, null, 2));
      return;
    }
    const modeLabelMap = {
      context: '上下文占比',
      speed: '速度与耗时',
      quota: '5h/Week 额度'
    };
    const mLbl = modeLabelMap[st.menubarMode || getMenubarMode()] || st.menubarMode;
    const convInfo = st.activeConvTitle ? ` · 跟随会话：${st.activeConvTitle}` : '';
    console.log(
      formatZh(
        st.menubarActive
          ? `${c.green}●${c.reset} 顶部菜单栏常驻运行中 (PID ${st.pid} · 模式：${mLbl} · 显示：${st.statusTitle || '◈ --%'}${convInfo})`
          : st.menubarEnabled
            ? `${c.yellow}◐${c.reset} 顶部菜单栏偏好已开启（模式：${mLbl}，执行 agy-context menubar on 可立即唤起）`
            : `${c.dim}○${c.reset} 顶部菜单栏常驻图标当前状态：已关闭`
      )
    );
    return;
  }

  const pickedMode = normalizeMenubarModeArg(sub);
  if (pickedMode && MENUBAR_MODES.includes(pickedMode)) {
    const res = await controlFloatWindow({ action: 'set-menubar-mode', menubarMode: pickedMode });
    if (rawArgs.includes('--json')) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (!res.ok) {
      console.error(formatZh(`${c.red}✗${c.reset} ${res.error || '切换失败'}`));
      process.exitCode = 1;
      return;
    }
    console.log(formatZh(`${c.green}✓${c.reset} ${res.message}`));
    return;
  }

  let menubarEnabled;
  if (['on', 'enable', 'true', '1'].includes(sub) || rawArgs.includes('--on')) {
    menubarEnabled = true;
  } else if (['off', 'disable', 'false', '0', 'close'].includes(sub) || rawArgs.includes('--off')) {
    menubarEnabled = false;
  }
  const res = await controlFloatWindow({ action: 'set-menubar', menubarEnabled });
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.ok) {
    console.error(formatZh(`${c.red}✗${c.reset} ${res.error || '切换失败'}`));
    process.exitCode = 1;
    return;
  }
  console.log(formatZh(`${c.green}✓${c.reset} ${res.message}`));
}

function runSidebarCommand(rawArgs) {
  const sub = (rawArgs.filter((a) => !a.startsWith('-'))[1] || 'toggle').toLowerCase();
  if (rawArgs.includes('--status') || sub === 'status') {
    const st = getSidebarEntryStatus();
    if (rawArgs.includes('--json')) {
      console.log(JSON.stringify(st, null, 2));
      return;
    }
    console.log(
      formatZh(
        st.sidebarEnabled
          ? `${c.green}●${c.reset} 方案 A（左侧栏 Plugins 常驻页签）当前状态：已开启`
          : `${c.dim}○${c.reset} 方案 A（左侧栏 Plugins 常驻页签）当前状态：已关闭`
      )
    );
    return;
  }

  const cur = getSidebarEntryStatus();
  let wantEnabled = !cur.sidebarEnabled;
  if (['on', 'enable', 'true', '1'].includes(sub) || rawArgs.includes('--on')) {
    wantEnabled = true;
  } else if (['off', 'disable', 'false', '0', 'close'].includes(sub) || rawArgs.includes('--off')) {
    wantEnabled = false;
  }
  const res = setSidebarEntrypoint(wantEnabled);
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.ok) {
    console.error(formatZh(`${c.red}✗${c.reset} ${res.error || '切换失败'}`));
    process.exitCode = 1;
    return;
  }
  console.log(formatZh(`${c.green}✓${c.reset} ${res.message}`));
}

async function runFloatCommand(rawArgs) {
  const sub = (rawArgs.filter((a) => !a.startsWith('-'))[1] || '').toLowerCase();
  let action = 'open';
  if (rawArgs.includes('--quit') || ['quit', 'kill', 'exit'].includes(sub)) {
    action = 'quit';
  } else if (rawArgs.includes('--close') || ['close', 'off', 'stop', 'hide', 'unpin-close'].includes(sub)) {
    action = 'close';
  } else if (rawArgs.includes('--toggle') || sub === 'toggle') {
    action = 'toggle';
  } else if (rawArgs.includes('--status') || sub === 'status') {
    action = 'status';
  }
  const pinned = !rawArgs.includes('--unpinned');
  const res = await controlFloatWindow({ action, pinned });
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.ok) {
    console.error(formatZh(`${c.red}✗${c.reset} ${res.error || '操作失败'}`));
    process.exitCode = 1;
    return;
  }
  if (action === 'status') {
    console.log(
      formatZh(
        res.running
          ? `${c.green}●${c.reset} 右侧独立看板显示中 (PID ${res.pid} · ${res.pinned ? '已置顶' : '普通窗口'}${res.menubarActive ? ` · 菜单栏 ${res.statusTitle || '已开启'}` : ''})`
          : res.menubarActive
            ? `${c.cyan}◈${c.reset} 右侧小窗已收回（顶部菜单栏常驻就绪：${res.statusTitle || '◈ --%'}，单击可秒开）`
            : `${c.dim}○${c.reset} 右侧独立看板当前未打开`
      )
    );
    return;
  }
  console.log(formatZh(`${c.green}✓${c.reset} ${res.message || (res.running ? '已打开独立看板' : '已收回独立看板')}`));
}

async function runWebServer(rawArgs) {
  const portIdx = rawArgs.indexOf('--port');
  const port = portIdx >= 0 && rawArgs[portIdx + 1] ? rawArgs[portIdx + 1] : '18970';
  const noOpen = rawArgs.includes('--no-open');
  const childArgs = [join(__dirname, 'main.mjs'), '--standalone', '--port', String(port)];
  if (!noOpen) childArgs.push('--open');

  const child = spawn(process.execPath, childArgs, { stdio: 'inherit' });
  await new Promise((resolvePromise) => {
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolvePromise();
    });
  });
}

function buildCompactSummary(ctx, hist) {
  const cx = ctx.context || {};
  const sp = ctx.speed || {};
  const st = cx.sessionTotals || {};
  const turns = ctx.turns || [];
  const sumAll = hist.analyticsBySource?.all?.summary || {};
  const sumDesktop = hist.analyticsBySource?.desktop?.summary || {};
  const sumCli = hist.analyticsBySource?.cli?.summary || {};
  const costPeriod = hist.analyticsBySource?.all?.costs?.period?.hybrid || {};
  const costAll = hist.analyticsBySource?.all?.costs?.allTime?.hybrid || {};
  const plan = hist.planStatus || {};
  const activeConvMeta = (ctx.recentConversations || []).find((item) => item.id === ctx.conversationId);

  return {
    pluginDirId: PLUGIN_DIR_ID,
    entrypoints: {
      sidecarAuxPane: `sidecar://${PLUGIN_DIR_ID}/dashboard/`,
      sidebarFullPane: `sidecar://${PLUGIN_DIR_ID}/dashboard/sidebar`,
      sidebarTabEnabled: getSidebarEntryStatus().sidebarEnabled,
      customizationSettings: `customization://${PLUGIN_DIR_ID}`
    },
    floatWindow: getFloatWindowStatus(),
    conversation: {
      id: ctx.conversationId || null,
      source: activeConvMeta?.source || 'desktop',
      title: ctx.conversationTitle || '未命名会话',
      model: cx.model || '未识别模型',
      usedTokens: cx.used ?? 0,
      budgetTokens: cx.budget ?? 0,
      pendingTokens: cx.pendingTokens ?? 0,
      usagePercent: cx.percent ?? null,
      usedFormatted: `${fmtTok(cx.used)} / ${fmtTok(cx.budget)} (${cx.percent ?? '--'}%)`,
      cacheHitPercent: cx.cacheHitPercent ?? null,
      speed: {
        latestTps: sp.tps ?? null,
        streamingTps: sp.streamingTps ?? null,
        avgTps: sp.avgTps ?? null,
        peakTps: sp.peakTps ?? null,
        ttftSec: sp.ttft ?? null,
        durationSec: sp.duration ?? null
      },
      sessionTotals: {
        cacheReadTokens: st.cacheTokens ?? 0,
        freshInputTokens: st.inputTokens ?? 0,
        outputTokens: st.outputTokens ?? 0,
        thinkingTokens: st.thinkingTokens ?? 0,
        grossTokens: st.totalTokens ?? 0,
        cacheHitPercent: st.cacheHitPercent ?? null,
        turnsCount: activeConvMeta?.turnsCount || turns.length || 0
      },
      roundApiCostUSD: Number((cx.roundCostUSD || 0).toFixed(4)),
      sessionApiCostUSD: Number((cx.sessionCostUSD || 0).toFixed(4)),
      status: cx.error?.title || '正常'
    },
    recentTurns: turns.slice(0, 8).map((t) => ({
      turn: t.turnIndex,
      contextTokens: t.totalTokens,
      deltaTokens: t.deltaTokens,
      outputTokens: t.outputTokens,
      tps: t.tps,
      costUSD: t.costUSD,
      tools: t.tools || []
    })),
    globalHistory: {
      totalTokens: fmtTok(sumAll.grandTotalTokens),
      desktopTokens: fmtTok(sumDesktop.grandTotalTokens),
      cliTokens: fmtTok(sumCli.grandTotalTokens),
      todayTokens: fmtTok(sumAll.todayTokens),
      monthTokens: fmtTok(sumAll.monthTokens),
      yearTokens: fmtTok(sumAll.yearTokens),
      conversations: hist.sources?.all?.conversationsCount || 0,
      desktopConversations: hist.sources?.desktop?.conversationsCount || 0,
      cliConversations: hist.sources?.cli?.conversationsCount || 0,
      activeDays: sumAll.activeDaysCount || 0,
      monthHybridCostUSD: Number((costPeriod.totalCostUSD || 0).toFixed(2)),
      allTimeHybridCostUSD: Number((costAll.totalCostUSD || 0).toFixed(2)),
      plan: `${plan.tierName || '未连接宿主'} (${plan.symbol || '$'}${plan.effectivePrice ?? '--'}/${plan.billingCycle || '月'})`
    },
    quotas: (hist.modelQuotas || []).map((q) => ({
      label: q.title || q.groupLabel || q.label || '模型配额池',
      remainingPercent: q.remainingPercent,
      resetText: q.resetTimeZh || q.resetCountdown || ''
    }))
  };
}

function printPrettyStatus(ctx, hist) {
  const s = buildCompactSummary(ctx, hist);
  const cv = s.conversation;
  const gh = s.globalHistory;
  const srcBadge = cv.source === 'cli' ? '[CLI]' : '[Desktop]';

  const out = [];
  out.push(`${c.bold}${c.magenta}◈ 上下文与 Token 看板${c.reset} ${c.dim}(v1.6.1 · Desktop + agy CLI)${c.reset}`);
  out.push(`${c.dim}${'─'.repeat(64)}${c.reset}`);

  if (!cv.id) {
    out.push('当前尚未检测到本地会话归档记录。');
  } else {
    out.push(`${c.bold}当前会话${c.reset}  ${c.cyan}${srcBadge}${c.reset} ${cv.title} ${c.dim}(${cv.id.slice(0, 8)})${c.reset}`);
    out.push(`活跃模型  ${c.bold}${cv.model}${c.reset}  ·  状态：${cv.status}`);
    out.push(`窗口水位  ${renderBar(cv.usagePercent)} ${c.bold}${cv.usagePercent ?? '--'}%${c.reset}  (${fmtTok(cv.usedTokens)} / ${fmtTok(cv.budgetTokens)}${cv.pendingTokens > 0 ? `，含待发送 +${fmtTok(cv.pendingTokens)}` : ''})`);
    out.push(`缓存速度  单轮缓存命中 ${c.bold}${cv.cacheHitPercent != null ? `${cv.cacheHitPercent}%` : '--'}${c.reset}  ·  最新 ${c.cyan}${cv.speed.latestTps ? `${cv.speed.latestTps} tok/s` : '--'}${c.reset} (均值 ${cv.speed.avgTps ?? '--'} / 峰值 ${cv.speed.peakTps ?? '--'} tok/s, TTFT ${cv.speed.ttftSec ?? '--'}s)`);
    out.push(`会话吞吐  共 ${cv.sessionTotals.turnsCount} 轮  ·  累计总吞吐 ${c.bold}${fmtTok(cv.sessionTotals.grossTokens)}${c.reset} (缓存 ${fmtTok(cv.sessionTotals.cacheReadTokens)} · 新增输入 ${fmtTok(cv.sessionTotals.freshInputTokens)} · 输出 ${fmtTok(cv.sessionTotals.outputTokens)})`);
    out.push(`参考折算  本轮 ${c.bold}${fmtUsd(cv.roundApiCostUSD, 4)}${c.reset}  ·  全会话累计 ${c.bold}${fmtUsd(cv.sessionApiCostUSD, 4)}${c.reset}`);
  }

  if (s.recentTurns.length > 0) {
    out.push('');
    out.push(`${c.bold}最近 5 轮上下文变化（倒序）${c.reset}`);
    for (const t of s.recentTurns.slice(0, 5)) {
      const d = Number(t.deltaTokens || 0);
      const dStr = d > 0 ? `${c.yellow}+${fmtTok(d)}${c.reset}` : d < 0 ? `${c.green}${fmtTok(d)}${c.reset}` : `${c.dim}0${c.reset}`;
      const toolStr = t.tools.length ? `  [${t.tools.slice(0, 3).join(', ')}]` : '';
      out.push(`  #${String(t.turn).padEnd(3)} 水位 ${fmtTok(t.contextTokens).padStart(7)} (${dStr})  ·  输出 ${fmtTok(t.outputTokens).padStart(6)}  ·  ${t.tps ? `${t.tps} tok/s` : '--'}${c.dim}${toolStr}${c.reset}`);
    }
  }

  out.push('');
  out.push(`${c.bold}本机多源历史汇总${c.reset} ${c.dim}(共 ${gh.conversations} 个会话：桌面端 ${gh.desktopConversations} / CLI ${gh.cliConversations} · 活跃 ${gh.activeDays} 天)${c.reset}`);
  out.push(`  累计总计 ${c.bold}${gh.totalTokens}${c.reset} (桌面 ${gh.desktopTokens} / CLI ${gh.cliTokens})  ·  今日 ${c.bold}${gh.todayTokens}${c.reset}  ·  本月 ${c.bold}${gh.monthTokens}${c.reset}  ·  本年 ${gh.yearTokens}`);
  out.push(`  费用参考 本月 ${c.bold}${fmtUsd(gh.monthHybridCostUSD)}${c.reset}  ·  历史累计 ${c.bold}${fmtUsd(gh.allTimeHybridCostUSD)}${c.reset}  ·  订阅 ${gh.plan}`);

  if (s.quotas.length > 0) {
    out.push('');
    out.push(`${c.bold}实时配额池余量${c.reset}`);
    for (const q of s.quotas.slice(0, 4)) {
      out.push(`  ${renderBar(q.remainingPercent, 12, true)} ${String(q.remainingPercent ?? '--').padStart(5)}%  ${q.label}${q.resetText ? ` ${c.dim}(重置：${q.resetText})${c.reset}` : ''}`);
    }
  }

  out.push(`${c.dim}${'─'.repeat(64)}${c.reset}`);
  out.push(`${c.dim}提示：agy-context menubar [context|speed|quota] 切换顶部菜单栏显示内容；agy-context float 弹出右侧置顶小窗。${c.reset}`);

  console.log(out.map(formatZh).join('\n'));
}

function printTurnsTable(ctx) {
  const turns = ctx.turns || [];
  const out = [];
  out.push(`${c.bold}会话逐轮上下文与工具调用明细${c.reset} ${c.dim}(${ctx.conversationTitle || ctx.conversationId || '无会话'})${c.reset}`);
  out.push(`${c.dim}${'─'.repeat(76)}${c.reset}`);
  if (!turns.length) {
    out.push('暂无轮次记录。');
  } else {
    for (const t of turns.slice(0, 20)) {
      const d = Number(t.deltaTokens || 0);
      const dStr = d > 0 ? `+${fmtTok(d)}` : fmtTok(d);
      const tools = (t.tools || []).length ? ` | 工具：${t.tools.join(', ')}` : '';
      out.push(
        `#${String(t.turnIndex).padEnd(3)} | 上下文 ${fmtTok(t.totalTokens).padStart(7)} (${dStr.padStart(7)}) | 输出 ${fmtTok(t.outputTokens).padStart(6)} | ${fmtUsd(t.costUSD, 4)} | ${t.tps ? `${t.tps} tok/s` : '--'}${tools}`
      );
    }
  }
  console.log(out.map(formatZh).join('\n'));
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--sync-manifest')) {
    syncSidebarManifestFromSettings();
    return;
  }
  if (rawArgs.includes('--ensure-menubar')) {
    await controlFloatWindow({ action: 'ensure-menubar' });
    return;
  }
  if (rawArgs.includes('-h') || rawArgs.includes('--help') || rawArgs[0] === 'help') {
    printHelp();
    return;
  }

  const firstPositional = rawArgs.find((a) => !a.startsWith('-')) || 'status';
  const knownCmds = new Set(['status', 'turns', 'json', 'web', 'serve', 'open', 'float', 'pin', 'menubar', 'sidebar']);
  const cmd = knownCmds.has(firstPositional.toLowerCase()) ? firstPositional.toLowerCase() : 'status';

  if (cmd === 'menubar') {
    await runMenubarCommand(rawArgs);
    return;
  }

  if (cmd === 'sidebar') {
    runSidebarCommand(rawArgs);
    return;
  }

  if (cmd === 'float' || cmd === 'pin') {
    await runFloatCommand(rawArgs);
    return;
  }

  if (cmd === 'web' || cmd === 'serve' || cmd === 'open') {
    await runWebServer(rawArgs);
    return;
  }

  const positionalRest = rawArgs.filter((a) => !a.startsWith('-'));
  const convArg = knownCmds.has((positionalRest[0] || '').toLowerCase())
    ? (positionalRest[1] || process.env.ANTIGRAVITY_CONVERSATION_ID || '')
    : (positionalRest[0] || process.env.ANTIGRAVITY_CONVERSATION_ID || '');

  const wantJson = cmd === 'json' || rawArgs.includes('--json');
  const wantFull = rawArgs.includes('--full');

  const [ctx, hist] = await Promise.all([
    scanConversation(convArg, { force: true }),
    collectTokenHistory({ force: true })
  ]);

  if (wantJson) {
    const payload = wantFull ? { context: ctx, history: hist } : buildCompactSummary(ctx, hist);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (cmd === 'turns') {
    printTurnsTable(ctx);
    return;
  }

  printPrettyStatus(ctx, hist);
}

main().catch((err) => {
  console.error(formatZh(`执行失败：${err.message}`));
  process.exitCode = 1;
});
