#!/usr/bin/env node
/**
 * Strict Verification & Privacy Audit Suite for Antigravity Context Viewer.
 * Run before packaging or pushing to GitHub:
 *   node scripts/verify.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function assert(cond, msg) {
  if (!cond) throw new Error(`校验失败：${msg}`);
}

function walkFiles(dir, out = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'dist', 'node_modules', 'data'].includes(d.name)) continue;
    const full = join(dir, d.name);
    if (d.isDirectory()) {
      walkFiles(full, out);
    } else if (d.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function rawHttpRequest({ port, method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolveReq({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8')
        });
      });
    });
    req.on('error', rejectReq);
    if (body) req.write(body);
    req.end();
  });
}

async function runHttpSecurityAndBoundarySuite(port, label) {
  // R7: malformed request targets must return 400 and keep server alive
  const rBadBracket = await rawHttpRequest({ port, path: '//[' });
  assert(rBadBracket.status === 400, `[${label}] GET //[ 应返回 400，实际 ${rBadBracket.status}`);
  const rBadOriginUrl = await rawHttpRequest({ port, path: '//evil.invalid/api/settings' });
  assert(rBadOriginUrl.status === 400, `[${label}] GET //evil.invalid 应返回 400，实际 ${rBadOriginUrl.status}`);

  // R1: untrusted Host or cross-site Origin must be rejected
  const rBadHost = await rawHttpRequest({ port, path: '/api/settings', headers: { Host: 'review.invalid' } });
  assert(rBadHost.status === 403, `[${label}] 外部 Host 应返回 403，实际 ${rBadHost.status}`);
  const rBadGetOrigin = await rawHttpRequest({
    port,
    path: '/api/settings',
    headers: { Origin: 'https://review.invalid' }
  });
  assert(rBadGetOrigin.status === 403, `[${label}] 外部 Origin 读取敏感 API 应返回 403，实际 ${rBadGetOrigin.status}`);

  // R1: simple POST with foreign Origin/Host/text/plain must be blocked and leave settings untouched
  const evilBody = JSON.stringify({ uiPreferences: { preset: 'pwned_marker' } });
  const rForeignPost = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: {
      Host: 'review.invalid',
      Origin: 'https://review.invalid',
      'Content-Type': 'text/plain'
    },
    body: evilBody
  });
  assert(rForeignPost.status === 403, `[${label}] 外部 Origin/Host POST 应返回 403，实际 ${rForeignPost.status}`);

  const rTextPlain = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: { 'Content-Type': 'text/plain' },
    body: evilBody
  });
  assert(rTextPlain.status === 415, `[${label}] text/plain POST 应返回 415，实际 ${rTextPlain.status}`);

  const rMissingToken = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: { 'Content-Type': 'application/json' },
    body: evilBody
  });
  assert(rMissingToken.status === 403, `[${label}] 缺少 X-CV-Token 的 POST 应返回 403，实际 ${rMissingToken.status}`);

  const rWrongToken = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: {
      'Content-Type': 'application/json',
      'X-CV-Token': '0'.repeat(48)
    },
    body: evilBody
  });
  assert(rWrongToken.status === 403, `[${label}] 错误 X-CV-Token 的 POST 应返回 403，实际 ${rWrongToken.status}`);

  // Protect terminal & entrypoint control routes as well
  const rCliBlocked = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/launch-cli',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert(rCliBlocked.status === 403, `[${label}] 未授权 POST /api/launch-cli 应返回 403，实际 ${rCliBlocked.status}`);

  const rEntryBlocked = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/entrypoints',
    headers: { 'Content-Type': 'application/json' },
    body: '{"sidebarEnabled":true}'
  });
  assert(rEntryBlocked.status === 403, `[${label}] 未授权 POST /api/entrypoints 应返回 403，实际 ${rEntryBlocked.status}`);

  const rBefore = await rawHttpRequest({ port, path: '/api/settings' });
  assert(rBefore.status === 200, `[${label}] 异常请求后 GET /api/settings 应仍返回 200，实际 ${rBefore.status}`);
  const beforeJson = JSON.parse(rBefore.body);
  assert(beforeJson.uiPreferences?.preset !== 'pwned_marker', `[${label}] 未授权 POST 不得修改已持久化设置`);

  // Authorized dashboard flow: load HTML -> extract CSRF meta -> POST JSON with X-CV-Token
  const rIndex = await rawHttpRequest({ port, path: '/' });
  assert(rIndex.status === 200, `[${label}] GET / 应返回 200，实际 ${rIndex.status}`);
  const tokenMatch = rIndex.body.match(/<meta\s+name="cv-csrf-token"\s+content="([0-9a-f]{48})">/i);
  assert(Boolean(tokenMatch?.[1]), `[${label}] GET / HTML 缺少 cv-csrf-token 元标签`);
  const csrfToken = tokenMatch[1];

  const rMalformedJson = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: {
      Origin: `http://127.0.0.1:${port}`,
      'Content-Type': 'application/json',
      'X-CV-Token': csrfToken
    },
    body: '{bad json'
  });
  assert(rMalformedJson.status === 400, `[${label}] 畸形 JSON 请求体应返回 400，实际 ${rMalformedJson.status}`);

  const rValidSave = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: {
      Origin: `http://127.0.0.1:${port}`,
      'Content-Type': 'application/json',
      'X-CV-Token': csrfToken
    },
    body: JSON.stringify({ uiPreferences: { preset: 'ocean' } })
  });
  assert(rValidSave.status === 200, `[${label}] 合法令牌保存设置应返回 200，实际 ${rValidSave.status}`);
  const rAfter = await rawHttpRequest({ port, path: '/api/settings' });
  const afterJson = JSON.parse(rAfter.body);
  assert(afterJson.uiPreferences?.preset === 'ocean', `[${label}] 合法保存后 preset 应更新为 ocean`);

  return { csrfToken };
}

async function main() {
  console.log('[verify] 1/6 检查 plugin.json 与 sidecar.json 规范...');
  const manifestPath = join(ROOT, 'plugin.json');
  assert(existsSync(manifestPath), '缺少根目录 plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  const allowedKeys = new Set([
    '$schema', 'name', 'displayName', 'version', 'description',
    'logo', 'suggestedPrompts', 'author', 'homepage', 'repository', 'disabled'
  ]);
  for (const k of Object.keys(manifest)) {
    assert(allowedKeys.has(k), `plugin.json 包含未知顶层字段：${k}`);
  }
  assert(/^[a-z0-9-]+$/.test(manifest.name), `plugin.json name 必须为 kebab-case：${manifest.name}`);
  assert(/^\d+\.\d+\.\d+/.test(manifest.version), `plugin.json version 需符合语义化版本：${manifest.version}`);
  assert(manifest.logo && !manifest.logo.startsWith('/') && !/^https?:/i.test(manifest.logo), 'logo 必须为插件相对路径');
  assert(existsSync(join(ROOT, manifest.logo)), `logo 文件不存在：${manifest.logo}`);
  assert(Array.isArray(manifest.suggestedPrompts) && manifest.suggestedPrompts.length <= 3, 'suggestedPrompts 最多 3 条');

  const sidecarPath = join(ROOT, 'sidecars', 'dashboard', 'sidecar.json');
  assert(existsSync(sidecarPath), '缺少 sidecars/dashboard/sidecar.json');
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
  assert(sidecar.command === 'node' && Array.isArray(sidecar.args) && sidecar.args[0] === 'main.mjs', 'sidecar.json 启动命令配置异常');
  assert(sidecar.has_web_ui === true, 'sidecar.json 需开启 has_web_ui');
  assert(
    sidecar.ui_config?.views?.[0]?.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
    'sidecar.json 首视图入口必须为 SIDECAR_UI_ENTRYPOINT_AUX_PANE'
  );
  const validEntrypoints = new Set([
    'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
    'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
    'SIDECAR_UI_ENTRYPOINT_FULL_PANE'
  ]);
  for (const v of sidecar.ui_config?.views || []) {
    assert(validEntrypoints.has(v.entrypoint), `sidecar.json 包含未知视图入口：${v.entrypoint}`);
  }

  const skillPath = join(ROOT, 'skills', 'context-viewer', 'SKILL.md');
  assert(existsSync(skillPath), '缺少 skills/context-viewer/SKILL.md');
  const skillRaw = readFileSync(skillPath, 'utf-8');
  assert(/^---\n[\s\S]*?name:\s*context-viewer[\s\S]*?description:\s*.+\n---/m.test(skillRaw), 'SKILL.md YAML frontmatter 缺失或不完整');

  console.log('[verify] 2/6 检查全部 JS / MJS 语法...');
  const allFiles = walkFiles(ROOT);
  for (const f of allFiles) {
    if (['.js', '.mjs'].includes(extname(f))) {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    }
  }

  console.log('[verify] 3/6 执行常见敏感路径、令牌模式、PNG 文本元数据块与 Git 身份隐私检查...');
  const strictGitIdentity = process.argv.includes('--strict-git-identity');
  const forbiddenPatterns = [
    { re: /\/Users\/[A-Za-z0-9._-]+/, label: 'macOS 个人主目录绝对路径 (/Users/...)' },
    { re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/, label: 'Windows 个人主目录绝对路径 (C:\\Users\\...)' },
    { re: /\/home\/[a-z0-9._-]+\//, label: 'Linux 个人主目录绝对路径 (/home/...)' },
    { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, label: '会话 UUID 硬编码' },
    { re: /\b(AIza[0-9A-Za-z-_]{35}|ghp_[0-9A-Za-z]{36}|sk-[0-9A-Za-z]{32,})\b/, label: '疑似 API Key / Token' },
    { re: /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b|example\.(?:com|org|net)\b|localhost\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, label: '未脱敏邮箱地址' },
    { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, label: 'PEM 私钥头' },
    { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/, label: '疑似明文 Bearer Token' },
    { re: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/, label: '带内联凭据的 URL' }
  ];
  const verifyRel = relative(ROOT, fileURLToPath(import.meta.url));
  const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico']);
  const forbiddenPngChunks = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);
  for (const f of allFiles) {
    const rel = relative(ROOT, f);
    if (rel === verifyRel) continue;
    const ext = extname(f).toLowerCase();
    if (binaryExts.has(ext)) {
      if (ext === '.png') {
        const buf = readFileSync(f);
        assert(
          buf.length >= 8 &&
            buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
          `PNG 文件签名无效：${rel}`
        );
        let offset = 8;
        while (offset + 8 <= buf.length) {
          const chunkLen = buf.readUInt32BE(offset);
          const chunkType = buf.subarray(offset + 4, offset + 8).toString('ascii');
          assert(!forbiddenPngChunks.has(chunkType), `PNG 图片 ${rel} 残留未剥离的元数据块：${chunkType}`);
          offset += 12 + chunkLen;
        }
      }
      continue;
    }
    const st = statSync(f);
    if (st.size > 2 * 1024 * 1024) continue;
    const text = readFileSync(f, 'utf-8');
    for (const pat of forbiddenPatterns) {
      const m = text.match(pat.re);
      const preview = m?.[0] ? `${m[0].slice(0, 4)}***` : '';
      assert(!m, `文件 ${rel} 命中敏感内容规则 [${pat.label}]：${preview}`);
    }
  }

  // Verify repository-managed pre-push hook script syntax and executable bit
  const prePushHookPath = join(ROOT, 'scripts', 'pre-push');
  assert(existsSync(prePushHookPath), '缺少仓库管理的 scripts/pre-push 钩子脚本');
  execFileSync('bash', ['-n', prePushHookPath], { stdio: 'pipe' });
  if (process.platform !== 'win32') {
    assert((statSync(prePushHookPath).mode & 0o111) !== 0, 'scripts/pre-push 缺少可执行权限');
  }

  // V1: Check unpushed Git commit metadata for non-noreply personal emails without printing plaintext emails/names
  if (existsSync(join(ROOT, '.git'))) {
    const isSafeCommitEmail = (email) => /@(?:users\.noreply\.github\.com|example\.(?:com|org|net))$/i.test(String(email || '').trim());
    let localGitEmail = '';
    try {
      localGitEmail = execFileSync('git', ['config', '--local', '--get', 'user.email'], { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8' }).trim();
    } catch {}
    let revRange = '';
    try {
      execFileSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: ROOT, stdio: 'pipe' });
      revRange = 'origin/main..HEAD';
    } catch {
      revRange = '-n5';
    }
    let gitLogRaw = '';
    try {
      gitLogRaw = execFileSync(
        'git',
        ['log', ...(revRange === '-n5' ? ['-n', '5'] : [revRange]), '--format=%h|%ae|%ce'],
        { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8' }
      ).trim();
    } catch {}
    const nonNoreplyHashes = [];
    for (const line of gitLogRaw ? gitLogRaw.split(/\r?\n/) : []) {
      const [shortHash, ae, ce] = line.split('|');
      if (shortHash && (!isSafeCommitEmail(ae) || !isSafeCommitEmail(ce))) {
        nonNoreplyHashes.push(shortHash);
      }
    }
    const localEmailNeedsFix = Boolean(strictGitIdentity && localGitEmail && !isSafeCommitEmail(localGitEmail));
    if (nonNoreplyHashes.length > 0 || localEmailNeedsFix) {
      const msgParts = [];
      if (nonNoreplyHashes.length > 0) msgParts.push(`未推送提交 (${nonNoreplyHashes.join(', ')}) 包含非 GitHub noreply 邮箱`);
      if (localEmailNeedsFix) msgParts.push('仓库本地 user.email 为非 noreply 邮箱');
      const summaryMsg = `${msgParts.join('；')}，推送前请确认公开身份或配置仓库级 noreply`;
      if (strictGitIdentity || (localGitEmail && isSafeCommitEmail(localGitEmail))) {
        assert(false, `V1 Git 身份门禁阻断：${summaryMsg}`);
      } else {
        console.log(`[verify] ⚠ 隐私提示：${summaryMsg}（运行 node scripts/verify.mjs --strict-git-identity 可严格阻断）`);
      }
    }
  }

  console.log('[verify] 4/6 检查宿主 CSS 隔离、零外部静态外链 (S2)、精确模型代际 (S4)、热力图 (R2) 与配额一致性 (R4 / F1)...');
  const indexHtmlSrc = readFileSync(join(ROOT, 'sidecars', 'dashboard', 'index.html'), 'utf-8');
  assert(!/https?:\/\//i.test(indexHtmlSrc), 'S2 index.html 仍残留外部 http(s) 资源链接');
  assert(
    indexHtmlSrc.includes(`/styles.css?v=${manifest.version}`) &&
      indexHtmlSrc.includes(`/app.js?v=${manifest.version}`),
    `index.html 静态资源版本查询参数未同步至 v${manifest.version}`
  );
  for (const f of ['styles.css', 'app.js']) {
    const p = join(ROOT, 'sidecars', 'dashboard', f);
    const s = readFileSync(p, 'utf-8');
    if (f === 'styles.css') {
      assert(!/https?:\/\//i.test(s), 'S2 styles.css 不得包含外部 http(s) 字体或资源链接');
    }
    const collisions = [...s.matchAll(/var\(--(muted|accent|bg|surface|surface-2|surface-3|fg|fg-2|border-strong)(?![-a-zA-Z0-9_])/g)];
    assert(collisions.length === 0, `${f} 存在未加 --cv- 前缀的易冲突变量引用：${collisions[0]?.[0]}`);
  }
  const appJsSrc = readFileSync(join(ROOT, 'sidecars', 'dashboard', 'app.js'), 'utf-8');
  assert(!/\(pool\.models\s*\|\|\s*\[\]\)\.slice\([^)]*\)\.join\(/.test(appJsSrc), 'app.js 直接对 pool.models 对象数组调用 join 会产生 [object Object]');

  // R2: Execute actual heatmap date & DOM rendering code from app.js across current, leap-year, cross-year & paged windows
  const heatSliceStart = appJsSrc.indexOf('  function parseLocalDate(ymd)');
  const heatSliceEnd = appJsSrc.indexOf('  function renderWeeklyBars(dailyMap, hist)');
  assert(heatSliceStart > 0 && heatSliceEnd > heatSliceStart, '未定位到 app.js 热力图函数区间');
  const domText = {};
  const domStage = {
    innerHTML: '',
    scrollWidth: 640,
    scrollLeft: 0,
    querySelectorAll: () => []
  };
  const domDayInspector = { innerHTML: '' };
  const domPrevBtn = { disabled: false };
  const domNextBtn = { disabled: false };
  const heatCtx = {
    state: { heatPageOffset: 0, selectedBucketKey: '' },
    $: (id) => {
      if (id === 'chart-stage') return domStage;
      if (id === 'day-inspector') return domDayInspector;
      if (id === 'btn-heat-prev') return domPrevBtn;
      if (id === 'btn-heat-next') return domNextBtn;
      return null;
    },
    setText: (id, val) => { domText[id] = String(val); },
    escZh: (v) => String(v ?? ''),
    fmtTokens: (n) => `${Number(n || 0)}`,
    fmtInt: (n) => `${Number(n || 0)}`,
    fmtUSD: (n) => `$${Number(n || 0).toFixed(2)}`,
    fmtCNY: (n) => `¥${(Number(n || 0) * 7.2).toFixed(2)}`,
    requestAnimationFrame: (fn) => fn()
  };
  const heatApi = runInNewContext(
    `${appJsSrc.slice(heatSliceStart, heatSliceEnd)}\n({ parseLocalDate, toYmd, computeHeatmapDateWindow, renderDailyHeatmap });`,
    heatCtx
  );

  const wCurr = heatApi.computeHeatmapDateWindow('2026-11-12', 0);
  assert(heatApi.toYmd(wCurr.startSun) === '2025-11-09', `R2 热力图起始日应为 2025-11-09，实际 ${heatApi.toYmd(wCurr.startSun)}`);
  assert(heatApi.toYmd(wCurr.endSat) === '2026-11-14', `R2 热力图结束周六应为 2026-11-14，实际 ${heatApi.toYmd(wCurr.endSat)}`);
  assert(wCurr.startSun.getDay() === 0 && wCurr.endSat.getDay() === 6, 'R2 热力图首末星期对齐异常');
  const walkDays = [];
  const walkCursor = new Date(wCurr.startSun);
  for (let i = 0; i < 371; i++) {
    walkDays.push(heatApi.toYmd(walkCursor));
    walkCursor.setDate(walkCursor.getDate() + 1);
  }
  assert(walkDays.length === 371 && new Set(walkDays).size === 371, 'R2 热力图 371 天不连续或存在重复日期');
  assert(walkDays[0] === '2025-11-09' && walkDays[370] === '2026-11-14' && walkDays.includes('2026-11-12'), 'R2 热力图未覆盖今日 2026-11-12');

  const wPrev = heatApi.computeHeatmapDateWindow('2026-11-12', 1);
  assert(
    heatApi.toYmd(wPrev.startSun) === '2024-11-03' &&
      heatApi.toYmd(wPrev.endSat) === '2025-11-08' &&
      heatApi.toYmd(wPrev.displayEnd) === '2025-11-08',
    `R2 热力图上一页区间异常：${heatApi.toYmd(wPrev.startSun)} ~ ${heatApi.toYmd(wPrev.endSat)}`
  );
  const wLeap = heatApi.computeHeatmapDateWindow('2024-02-29', 0);
  assert(
    heatApi.toYmd(wLeap.startSun) === '2023-02-26' && heatApi.toYmd(wLeap.endSat) === '2024-03-02',
    `R2 闰年热力图窗口异常：${heatApi.toYmd(wLeap.startSun)} ~ ${heatApi.toYmd(wLeap.endSat)}`
  );
  const wNewYear = heatApi.computeHeatmapDateWindow('2026-01-01', 0);
  assert(
    heatApi.toYmd(wNewYear.startSun) === '2024-12-29' && heatApi.toYmd(wNewYear.endSat) === '2026-01-03',
    `R2 跨年热力图窗口异常：${heatApi.toYmd(wNewYear.startSun)} ~ ${heatApi.toYmd(wNewYear.endSat)}`
  );

  heatApi.renderDailyHeatmap(
    { '2026-11-12': { total: 42000, input: 10000, cache: 30000, output: 2000, steps: 3, costUSD: 0.12, refCostUSD: 0.12 } },
    { todayKey: '2026-11-12', firstUseDate: '2026-11-01', planStatus: { monthlyUSD: 19.99 } }
  );
  assert(domText['heat-range-label'] === '2025-11-09 至 2026-11-12', `R2 热力图标题区间异常：${domText['heat-range-label']}`);
  assert(/class="heat-cell" data-lvl="[1-4]" data-day="2026-11-12"/.test(domStage.innerHTML), 'R2 今日有记录时热力图单元格未点亮');
  assert(domText['sum-tok'] === '42000', `R2 热力图区间汇总异常：${domText['sum-tok']}`);

  // Pricing, S4 generational precision, R4 & F1 quota grouping / single-model parity checks
  const {
    classifyRequestError,
    groupModelQuotas,
    maskEmail,
    normalizeModelId,
    parseUserPlanStatus,
    resolveEffectivePlanStatus,
    resolveModelQuota,
    sanitizeDiagnosticText,
    summarizeApiCost
  } = await import(join(ROOT, 'sidecars', 'dashboard', 'pricing.mjs'));

  // Privacy hardening: custom-domain email masking & error diagnostic sanitization
  assert(
    maskEmail('demo@gmail.com') === 'de***@gmail.com' &&
      maskEmail('owner@custom-studio.dev') === 'ow***@c***.dev' &&
      maskEmail('staff@eng.corp.co.uk') === 'st***@e***.co.uk',
    `自定义域邮箱掩码结果异常：gmail=${maskEmail('demo@gmail.com')}, custom=${maskEmail('owner@custom-studio.dev')}, uk=${maskEmail('staff@eng.corp.co.uk')}`
  );
  const rawSensitiveErr = '503 UNAVAILABLE https://api.internal.test/v1?key=1 Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 sk-abcdefghijklmnopqrstuvwxyz123456 /Users/secretuser/proj/a.js admin@private-corp.io';
  const cleanDiag = sanitizeDiagnosticText(rawSensitiveErr, 300);
  const cleanErrObj = classifyRequestError(rawSensitiveErr);
  assert(
    !cleanDiag.includes('api.internal.test') &&
      !cleanDiag.includes('eyJhbGci') &&
      !cleanDiag.includes('abcdefghijklmnopqrstuvwxyz') &&
      !cleanDiag.includes('secretuser') &&
      !cleanDiag.includes('private-corp') &&
      cleanErrObj.kind === 'service_unavailable' &&
      !cleanErrObj.diagnostic.includes('secretuser') &&
      !cleanErrObj.diagnostic.includes('private-corp') &&
      !cleanErrObj.diagnostic.includes('eyJhbGci'),
    `错误诊断脱敏失败或破坏错误分类：kind=${cleanErrObj.kind}, diag=${cleanErrObj.diagnostic}`
  );

  // S4: Exact generational matching only — unknown or older generations must return null (unpriced -> Hybrid)
  assert(normalizeModelId('Gemini 4 Carbon (High)') === 'gemini-4-carbon', 'S4 Gemini 4 Carbon 匹配异常');
  assert(normalizeModelId('Gemini 4 Argon') === 'gemini-4-argon', 'S4 Gemini 4 Argon 匹配异常');
  assert(normalizeModelId('Gemini 3.8 Flash') === 'gemini-3.8-flash', 'S4 Gemini 3.8 Flash 匹配异常');
  assert(normalizeModelId('Gemini 3.5 Flash-Lite') === 'gemini-3.5-flash-lite', 'S4 Gemini 3.5 Flash-Lite 匹配异常');
  assert(normalizeModelId('Gemini 3.1 Pro (High)') === 'gemini-3.1-pro-preview', 'S4 Gemini 3.1 Pro 匹配异常');
  assert(normalizeModelId('Gemini 2.5 Pro') === 'gemini-2.5-pro', 'S4 Gemini 2.5 Pro 匹配异常');
  assert(normalizeModelId('Claude Opus 5.5 (Thinking)') === 'claude-opus-5-5', 'S4 Claude Opus 5.5 匹配异常');
  assert(normalizeModelId('Claude Sonnet 5.5') === 'claude-sonnet-5-5', 'S4 Claude Sonnet 5.5 匹配异常');
  assert(normalizeModelId('GPT-OSS 120B (Medium)') === 'gpt-oss-120b', 'S4 GPT-OSS 120B 匹配异常');
  for (const unpricedGen of [
    'Claude 3.5 Sonnet',
    'Claude Sonnet 4',
    'Claude Sonnet',
    'Claude 3 Opus',
    'Claude Opus 4',
    'Claude Opus',
    'Gemini 1.5 Flash',
    'Gemini 2.5 Flash',
    'Gemini Flash',
    'Gemini 2.0 Flash-Lite',
    'Flash-Lite',
    'GPT-OSS 20B'
  ]) {
    assert(normalizeModelId(unpricedGen) === null, `S4 非当前代际或泛称模型 "${unpricedGen}" 不应误绑已知代际费率`);
  }
  const s4Summary = summarizeApiCost([
    { model: 'Claude 3.5 Sonnet', inputTokens: 1000, outputTokens: 200 },
    { model: '', inputTokens: 500, outputTokens: 100 }
  ]);
  assert(
    s4Summary.pricedRequestsCount === 0 &&
      s4Summary.unpricedRequestsCount === 2 &&
      s4Summary.unpricedReasons.unsupportedModel === 1 &&
      s4Summary.unpricedReasons.missingModel === 1 &&
      s4Summary.byModel.some((m) => m.displayName === 'Claude 3.5 Sonnet' && m.unpriced && !m.missingModel),
    'S4 未收录代际模型在 summarizeApiCost 中未正确归入 unsupportedModel / 保留真实显示名'
  );
  const ultraParsed = parseUserPlanStatus({
    userStatus: {
      userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
      planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } }
    }
  });
  assert(ultraParsed.tierKey === 'ultra' && ultraParsed.tierName === 'Google AI Ultra', `Ultra 档位名称识别异常：${ultraParsed.tierName}`);
  const ultraDefaultEff = resolveEffectivePlanStatus(ultraParsed, null);
  assert(ultraDefaultEff.effectivePrice === 249.99 && !ultraDefaultEff.isCustomized, `Ultra 默认参考价异常：${ultraDefaultEff.effectivePrice}`);
  const ultraFamilyEff = resolveEffectivePlanStatus(ultraParsed, { acquisitionId: 'family_sharing', zeroExtra: true });
  assert(ultraFamilyEff.monthlyNormalized === 0 && ultraFamilyEff.isCustomized, '家庭组免额外付费折算异常');

  const samplePools = groupModelQuotas([
    { label: 'Gemini 4 Carbon (High)', modelId: 'M1', quotaInfo: { remainingFraction: 0.934, resetTime: '2026-11-12T07:05:09Z' } },
    { label: 'Gemini 4 Carbon (Low)', modelId: 'M2', quotaInfo: { remainingFraction: 0.934, resetTime: '2026-11-12T07:05:09Z' } },
    { label: 'Gemini 3.8 Flash (High)', modelId: 'M3', quotaInfo: { remainingFraction: 0.934, resetTime: '2026-11-12T07:05:09Z' } }
  ], [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.998, resetTime: '2026-11-12T12:05:09Z' },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.926, resetTime: '2026-11-18T02:35:16Z' }
      ]
    }
  ]);
  assert(samplePools.length === 1 && Array.isArray(samplePools[0].families) && samplePools[0].families.join(' / ') === 'Gemini 4 Carbon / Gemini 3.8 Flash', 'groupModelQuotas families 聚合结果异常');
  assert(samplePools[0].fiveHour?.remainingPercent === 99.8 && samplePools[0].weekly?.remainingPercent === 92.6, 'RetrieveUserQuotaSummary 5h + weekly 合并异常');
  assert(!JSON.stringify(samplePools).includes('[object Object]'), '配额池序列化包含 [object Object]');

  // R4: Distinct model groups with identical remainingFraction + resetTime (or missing quotaInfo) must never merge
  const sharedRawQuota = { remainingFraction: 1, resetTime: '2026-11-13T10:00:00Z' };
  const summaryGroupsAB = [
    { displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.8 }] },
    { displayName: 'Claude Models', buckets: [{ window: '5h', remainingFraction: 0.2 }] }
  ];
  const r4Pools = groupModelQuotas([
    { label: 'Gemini 4 Carbon', quotaInfo: sharedRawQuota },
    { label: 'Claude Opus 5.5', quotaInfo: sharedRawQuota }
  ], summaryGroupsAB);
  assert(r4Pools.length === 2, `R4 同余额不同品牌池不应合并，实际池数 ${r4Pools.length}`);
  const geminiPoolA = r4Pools.find((p) => p.families.includes('Gemini 4 Carbon'));
  const claudePoolA = r4Pools.find((p) => p.families.includes('Claude Opus 5.5'));
  assert(geminiPoolA?.remainingPercent === 80 && claudePoolA?.remainingPercent === 20, 'R4 Gemini/Claude 分池百分比异常');

  const r4Reversed = groupModelQuotas([
    { label: 'Gemini 4 Carbon', quotaInfo: null },
    { label: 'Claude Opus 5.5', quotaInfo: null }
  ], [...summaryGroupsAB].reverse());
  const geminiPoolB = r4Reversed.find((p) => p.families.includes('Gemini 4 Carbon'));
  const claudePoolB = r4Reversed.find((p) => p.families.includes('Claude Opus 5.5'));
  assert(
    r4Reversed.length === 2 && geminiPoolB?.remainingPercent === 80 && claudePoolB?.remainingPercent === 20,
    'R4 翻转 summaryGroups 顺序或缺失 quotaInfo 时分池结果不一致'
  );

  const r4HighLow = groupModelQuotas([
    { label: 'Gemini 4 Carbon (High)', quotaInfo: sharedRawQuota },
    { label: 'Gemini 4 Carbon (Low)', quotaInfo: sharedRawQuota },
    { label: 'Claude Opus 5.5 (Thinking)', quotaInfo: sharedRawQuota }
  ], []);
  assert(r4HighLow.length === 2, `R4 无 summaryGroups 时同族 High/Low 应合并而跨族应隔离，实际池数 ${r4HighLow.length}`);

  // F1: Multi-pool same-brand resolution parity across groupModelQuotas & resolveModelQuota
  const f1Configs = [
    { label: 'Gemini 4 Carbon', modelId: 'M1', quotaInfo: { poolId: 'g-carbon', remainingFraction: 0.9 } },
    { label: 'Gemini 3.8 Flash', modelId: 'M2', quotaInfo: { poolId: 'g-flash', remainingFraction: 0.9 } }
  ];
  const f1Groups = [
    { groupId: 'g-carbon', displayName: 'Gemini Group A', modelIds: ['M1'], buckets: [{ window: '5h', remainingFraction: 0.8 }] },
    { groupId: 'g-flash', displayName: 'Gemini Group B', modelIds: ['M2'], buckets: [{ window: '5h', remainingFraction: 0.2 }] }
  ];
  const f1Pools = groupModelQuotas(f1Configs, f1Groups);
  const f1Carbon = resolveModelQuota('Gemini 4 Carbon', f1Configs, f1Groups);
  const f1Flash = resolveModelQuota('Gemini 3.8 Flash', f1Configs, f1Groups);
  const f1FlashRev = resolveModelQuota('Gemini 3.8 Flash', f1Configs, [...f1Groups].reverse());
  assert(
    f1Pools.length === 2 &&
      f1Pools.find((p) => p.families.includes('Gemini 4 Carbon'))?.remainingPercent === 80 &&
      f1Pools.find((p) => p.families.includes('Gemini 3.8 Flash'))?.remainingPercent === 20 &&
      f1Carbon?.remainingPercent === 80 &&
      f1Flash?.remainingPercent === 20 &&
      f1FlashRev?.remainingPercent === 20,
    `F1 同品牌双 Gemini 池列表与单模型配额不一致：Carbon=${f1Carbon?.remainingPercent} Flash=${f1Flash?.remainingPercent}`
  );

  // F1b: Explicit poolId-only (no modelIds) & explicit modelIds-only (identical displayName, no groupId)
  const f1PoolIdOnlyGroups = [
    { groupId: 'g-carbon', displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.8 }] },
    { groupId: 'g-flash', displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.2 }] }
  ];
  assert(
    resolveModelQuota('Gemini 3.8 Flash', f1Configs, f1PoolIdOnlyGroups)?.remainingPercent === 20,
    'F1 仅含显式 poolId/groupId 时未命中对应 Gemini 子池'
  );
  const f1ModelIdsOnlyConfigs = [
    { label: 'Gemini 4 Carbon', modelId: 'M1', quotaInfo: { remainingFraction: 0.9 } },
    { label: 'Gemini 3.8 Flash', modelId: 'M2', quotaInfo: { remainingFraction: 0.9 } }
  ];
  const f1ModelIdsOnlyGroups = [
    { displayName: 'Gemini', modelIds: ['M1'], buckets: [{ window: '5h', remainingFraction: 0.8 }] },
    { displayName: 'Gemini', modelIds: ['M2'], buckets: [{ window: '5h', remainingFraction: 0.2 }] }
  ];
  assert(
    groupModelQuotas(f1ModelIdsOnlyConfigs, f1ModelIdsOnlyGroups).length === 2 &&
      resolveModelQuota('Gemini 3.8 Flash', f1ModelIdsOnlyConfigs, f1ModelIdsOnlyGroups)?.remainingPercent === 20,
    'F1 同名 displayName 仅靠 modelIds 区分时配额分池或单模型解析异常'
  );

  // F1c: Ambiguous equal-score brand ties must reject arbitrary tie-breaking and preserve raw quotaInfo
  const f1AmbiguousConfigs = [
    { label: 'Gemini 3.8 Flash', modelId: 'M2', quotaInfo: { remainingFraction: 0.55 } }
  ];
  const f1AmbiguousGroups = [
    { displayName: 'Gemini Group A', buckets: [{ window: '5h', remainingFraction: 0.8 }] },
    { displayName: 'Gemini Group B', buckets: [{ window: '5h', remainingFraction: 0.2 }] }
  ];
  assert(
    resolveModelQuota('Gemini 3.8 Flash', f1AmbiguousConfigs, f1AmbiguousGroups)?.remainingPercent === 55 &&
      resolveModelQuota('Gemini 3.8 Flash', f1AmbiguousConfigs, [...f1AmbiguousGroups].reverse())?.remainingPercent === 55,
    'F1 歧义同分候选组不应按字母序猜测覆盖原始 quotaInfo'
  );

  // Build reusable VM harness executing actual app.js renderers (Tab 1 Context/Quota + Tab 3 Quota Pools)
  const usdConstIdx = appJsSrc.indexOf('  const USD_TO_CNY =');
  const presetsIdx = appJsSrc.indexOf('  const HEAT_PRESETS =');
  const fmtZhIdx = appJsSrc.indexOf('  function formatZh(');
  const toastIdx = appJsSrc.indexOf('  function showToast(');
  const knownPctIdx = appJsSrc.indexOf('  function isKnownPct(');
  const tab2Idx = appJsSrc.indexOf('  // TAB 2: Token History');
  const costPanelIdx = appJsSrc.indexOf('  function renderCostPanel(hist)');
  const switchTabIdx = appJsSrc.indexOf('  function switchTab(tabName)');
  assert(
    usdConstIdx > 0 && fmtZhIdx > 0 && knownPctIdx > 0 && tab2Idx > knownPctIdx && costPanelIdx > tab2Idx && switchTabIdx > costPanelIdx,
    '未定位到 app.js 渲染函数代码切片边界'
  );
  const createAppRenderHarness = () => {
    const els = new Map();
    const getEl = (id) => {
      if (!els.has(id)) {
        const classes = new Set();
        const el = {
          id,
          textContent: '',
          innerHTML: '',
          style: {},
          attrs: {},
          set className(v) {
            classes.clear();
            String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
          },
          get className() {
            return [...classes].join(' ');
          },
          classList: {
            add: (...names) => names.forEach((n) => classes.add(n)),
            remove: (...names) => names.forEach((n) => classes.delete(n)),
            toggle: (n, force) => {
              const next = force === undefined ? !classes.has(n) : Boolean(force);
              if (next) classes.add(n);
              else classes.delete(n);
              return next;
            },
            contains: (n) => classes.has(n)
          },
          setAttribute: (k, v) => { el.attrs[k] = String(v); }
        };
        els.set(id, el);
      }
      return els.get(id);
    };
    const vmCtx = {
      $: (id) => getEl(id),
      state: {
        selectedConvId: '',
        sourceFilter: 'all',
        costScope: 'period',
        costMode: 'hybrid',
        turnsFilter: 'all',
        contextData: null,
        historyData: null,
        ui: { budgetOverride: 0 }
      },
      fmtLocalTime: () => '10:00'
    };
    const combinedSrc = [
      appJsSrc.slice(usdConstIdx, presetsIdx),
      appJsSrc.slice(fmtZhIdx, toastIdx),
      appJsSrc.slice(knownPctIdx, tab2Idx),
      appJsSrc.slice(costPanelIdx, switchTabIdx)
    ].join('\n');
    runInNewContext(combinedSrc, vmCtx);
    return { vmCtx, getEl };
  };

  // T1: Exhaustive quota semantics matrix (5h+weekly, 5h-only, weekly-only, resetTime-only, all-missing, genuine 0%)
  const t1Configs = [
    { label: 'Model Both', modelId: 'T1_BOTH', quotaInfo: { poolId: 'p-both', remainingFraction: 0.8 } },
    { label: 'Model 5hOnly', modelId: 'T1_5H', quotaInfo: { poolId: 'p-5h' } },
    { label: 'Model WeekOnly', modelId: 'T1_WK', quotaInfo: { poolId: 'p-wk' } },
    { label: 'Model ResetOnly', modelId: 'T1_RST', quotaInfo: { poolId: 'p-rst', resetTime: '2026-11-12T16:00:00Z' } },
    { label: 'Model Missing', modelId: 'T1_MISS', quotaInfo: null },
    { label: 'Model Zero', modelId: 'T1_ZERO', quotaInfo: { poolId: 'p-zero', remainingFraction: 0, resetTime: '2026-11-12T15:00:00Z' } }
  ];
  const t1Groups = [
    {
      groupId: 'p-both',
      modelIds: ['T1_BOTH'],
      buckets: [
        { window: '5h', remainingFraction: 0.8, resetTime: '2026-11-12T15:00:00Z' },
        { window: 'weekly', remainingFraction: 0.2, resetTime: '2026-11-15T00:00:00Z' }
      ]
    },
    {
      groupId: 'p-5h',
      modelIds: ['T1_5H'],
      buckets: [{ window: '5h', remainingFraction: 0.65, resetTime: '2026-11-12T15:00:00Z' }]
    },
    {
      groupId: 'p-wk',
      modelIds: ['T1_WK'],
      buckets: [{ window: 'weekly', remainingFraction: 0.2, resetTime: '2026-11-15T00:00:00Z' }]
    },
    {
      groupId: 'p-rst',
      modelIds: ['T1_RST'],
      buckets: [{ window: '5h', resetTime: '2026-11-12T16:00:00Z' }]
    }
  ];
  const t1Pools = groupModelQuotas(t1Configs, t1Groups);
  const findT1Pool = (lbl) => t1Pools.find((p) => p.families.includes(lbl));
  assert(
    findT1Pool('Model Both')?.fiveHour?.remainingPercent === 80 &&
      findT1Pool('Model Both')?.weekly?.remainingPercent === 20,
    'T1 双窗口 (5h + weekly) 解析异常'
  );
  assert(
    findT1Pool('Model 5hOnly')?.fiveHour?.remainingPercent === 65 &&
      findT1Pool('Model 5hOnly')?.weekly === null,
    'T1 独立 5h 窗口解析异常'
  );
  const t1WkPool = findT1Pool('Model WeekOnly');
  const t1WkModelQ = resolveModelQuota('Model WeekOnly', t1Configs, t1Groups);
  assert(
    t1WkPool?.fiveHour === null &&
      t1WkPool?.remainingPercent === null &&
      t1WkPool?.weekly?.remainingPercent === 20 &&
      t1WkModelQ?.remainingPercent === null &&
      t1WkModelQ?.weekly?.remainingPercent === 20,
    `T1 仅含 weekly 窗口不应伪造 5h 或丢失周配额：${JSON.stringify(t1WkPool)}`
  );
  const t1RstPool = findT1Pool('Model ResetOnly');
  assert(
    t1RstPool?.remainingPercent === null &&
      t1RstPool?.fiveHour?.remainingPercent === null &&
      Boolean(t1RstPool?.fiveHour?.resetTimeZh),
    'T1 仅含 resetTime 时 remainingPercent 应保持 null 且保留重置时间'
  );
  assert(findT1Pool('Model Missing')?.remainingPercent === null, 'T1 全缺失配额应保持 null');
  assert(findT1Pool('Model Zero')?.remainingPercent === 0, 'T1 真实 0% 配额不得误判为缺失');

  const t1Harness = createAppRenderHarness();
  // T1 UI check 1: weekly-only pool + active model must show 20.0% Week and NEVER render 100.0%
  t1Harness.vmCtx.renderCostPanel({ planStatus: { status: 'identified', tierName: 'Pro' }, modelQuotas: [t1WkPool] });
  const wkListHtml = t1Harness.getEl('quota-pools-list').innerHTML;
  assert(
    wkListHtml.includes('Week') && wkListHtml.includes('20.0%') && !wkListHtml.includes('100.0%'),
    `T1 Tab3 仅 weekly 配额池未显示 20.0% 或误回退为 100.0%：${wkListHtml}`
  );
  t1Harness.vmCtx.renderSpeedCard(null, { quota: t1WkModelQ }, [], null);
  assert(
    !t1Harness.getEl('ctx-quota-box').classList.contains('hidden') &&
      t1Harness.getEl('ctx-quota-val').textContent.includes('周 20.0%') &&
      t1Harness.getEl('ctx-quota-bar').style.width === '20%',
    `T1 Tab1 仅 weekly 当前模型配额被隐藏或渲染异常：${t1Harness.getEl('ctx-quota-val').textContent}`
  );

  // T1 UI check 2: resetTime-only & all-missing must render "余量未知" with width 0%, NEVER 100.0% or 0.0%
  t1Harness.vmCtx.renderCostPanel({
    planStatus: { status: 'identified', tierName: 'Pro' },
    modelQuotas: [t1RstPool, findT1Pool('Model Missing')]
  });
  const unknownListHtml = t1Harness.getEl('quota-pools-list').innerHTML;
  assert(
    unknownListHtml.includes('余量未知') &&
      unknownListHtml.includes('width:0%') &&
      !unknownListHtml.includes('100.0%') &&
      !unknownListHtml.includes('0.0%'),
    `T1 未知配额误渲染为 100.0% 或 0.0%：${unknownListHtml}`
  );
  const t1MissModelQ = resolveModelQuota('Model Missing', t1Configs, t1Groups);
  t1Harness.vmCtx.renderSpeedCard(null, { quota: t1MissModelQ }, [], null);
  assert(
    !t1Harness.getEl('ctx-quota-box').classList.contains('hidden') &&
      t1Harness.getEl('ctx-quota-val').textContent.includes('余量未知') &&
      t1Harness.getEl('ctx-quota-bar').style.width === '0%',
    `T1 Tab1 缺失配额未显示余量未知：${t1Harness.getEl('ctx-quota-val').textContent}`
  );

  // T1 UI check 3: genuine 0% must render 0.0% with danger color
  t1Harness.vmCtx.renderCostPanel({
    planStatus: { status: 'identified', tierName: 'Pro' },
    modelQuotas: [findT1Pool('Model Zero')]
  });
  const zeroListHtml = t1Harness.getEl('quota-pools-list').innerHTML;
  assert(
    zeroListHtml.includes('0.0%') && zeroListHtml.includes('var(--danger)'),
    `T1 真实 0% 配额未渲染为 0.0% 告警态：${zeroListHtml}`
  );

  // U3: Base quota known (40% or 0%) + reset-only 5h summary bucket must NOT mask known base quota
  const u3FiveReset = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const u3Configs = [
    {
      label: 'U3 Base 40 Reset5h',
      modelId: 'U3_BASE_40',
      quotaInfo: { poolId: 'u3-p-40', remainingFraction: 0.4, resetTime: u3FiveReset }
    },
    {
      label: 'U3 Base 0 Reset5h',
      modelId: 'U3_BASE_0',
      quotaInfo: { poolId: 'u3-p-0', remainingFraction: 0, resetTime: u3FiveReset }
    },
    {
      label: 'U3 Explicit 5h 80',
      modelId: 'U3_EXP_80',
      quotaInfo: { poolId: 'u3-p-80', remainingFraction: 0.4, resetTime: u3FiveReset }
    }
  ];
  const u3Groups = [
    { groupId: 'u3-p-40', modelIds: ['U3_BASE_40'], buckets: [{ window: '5h', resetTime: u3FiveReset }] },
    { groupId: 'u3-p-0', modelIds: ['U3_BASE_0'], buckets: [{ window: '5h', resetTime: u3FiveReset }] },
    { groupId: 'u3-p-80', modelIds: ['U3_EXP_80'], buckets: [{ window: '5h', remainingFraction: 0.8, resetTime: u3FiveReset }] }
  ];
  const u3Pools = groupModelQuotas(u3Configs, u3Groups);
  const findU3Pool = (lbl) => u3Pools.find((p) => p.families.includes(lbl));
  const u3Base40Pool = findU3Pool('U3 Base 40 Reset5h');
  const u3Base0Pool = findU3Pool('U3 Base 0 Reset5h');
  const u3Exp80Pool = findU3Pool('U3 Explicit 5h 80');
  const u3Base40ModelQ = resolveModelQuota('U3 Base 40 Reset5h', u3Configs, u3Groups);
  const u3Base0ModelQ = resolveModelQuota('U3 Base 0 Reset5h', u3Configs, u3Groups);
  const u3Exp80ModelQ = resolveModelQuota('U3 Explicit 5h 80', u3Configs, u3Groups);
  assert(
    u3Base40Pool?.baseRemainingPercent === 40 &&
      u3Base40Pool?.fiveHour?.remainingPercent === null &&
      u3Base0Pool?.baseRemainingPercent === 0 &&
      u3Base0Pool?.fiveHour?.remainingPercent === null &&
      u3Exp80Pool?.remainingPercent === 80 &&
      u3Exp80Pool?.fiveHour?.remainingPercent === 80 &&
      u3Base40ModelQ?.baseRemainingPercent === 40 &&
      u3Base0ModelQ?.baseRemainingPercent === 0 &&
      u3Exp80ModelQ?.fiveHour?.remainingPercent === 80,
    `U3 基础配额 + 重置时间摘要解析异常：40=${JSON.stringify(u3Base40Pool)}, 0=${JSON.stringify(u3Base0Pool)}`
  );
  t1Harness.vmCtx.renderCostPanel({
    planStatus: { status: 'identified', tierName: 'Pro' },
    modelQuotas: [u3Base40Pool, u3Base0Pool, u3Exp80Pool]
  });
  const u3CostHtml = t1Harness.getEl('quota-pools-list').innerHTML;
  assert(
    u3CostHtml.includes('基础配额窗口') &&
      u3CostHtml.includes('40.0%') &&
      u3CostHtml.includes('0.0%') &&
      u3CostHtml.includes('80.0%') &&
      u3CostHtml.includes('var(--danger)'),
    `U3 Tab3 基础配额未在仅含重置时间摘要时保留展示：${u3CostHtml}`
  );
  t1Harness.vmCtx.renderSpeedCard(null, { quota: u3Base40ModelQ }, [], null);
  assert(
    t1Harness.getEl('ctx-quota-val').textContent.includes('基础 40.0%') &&
      t1Harness.getEl('ctx-quota-bar').style.width === '40%',
    `U3 Tab1 基础 40% + reset-only 5h 显示异常：${t1Harness.getEl('ctx-quota-val').textContent}`
  );
  t1Harness.vmCtx.renderSpeedCard(null, { quota: u3Base0ModelQ }, [], null);
  assert(
    t1Harness.getEl('ctx-quota-val').textContent.includes('基础 0.0%') &&
      t1Harness.getEl('ctx-quota-bar').style.width === '0%',
    `U3 Tab1 基础 0% + reset-only 5h 显示异常：${t1Harness.getEl('ctx-quota-val').textContent}`
  );
  t1Harness.vmCtx.renderSpeedCard(null, { quota: u3Exp80ModelQ }, [], null);
  assert(
    t1Harness.getEl('ctx-quota-val').textContent.includes('5h 80.0%') &&
      !t1Harness.getEl('ctx-quota-val').textContent.includes('基础 40.0%'),
    `U3 Tab1 显式 5h 摘要应优先于基础配额：${t1Harness.getEl('ctx-quota-val').textContent}`
  );

  console.log('[verify] 5/6 执行隔离采集器回归测试（R3/T2 配额状态机与 ETag / R5 离线计费 / R6 版本号 / R8 中文路径 / F1-F2 / T3 预算上限）...');
  const tmpVerifyRoot = mkdtempSync(join(tmpdir(), 'ag-cv-verify-'));
  const savedEnv = {
    AG_DIR: process.env.AG_DIR,
    AG_CLI_DIR: process.env.AG_CLI_DIR,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN
  };

  try {
    const isolatedAgDir = join(tmpVerifyRoot, 'ag-desktop');
    const isolatedCliDir = join(tmpVerifyRoot, 'ag-cli');
    const isolatedStateDir = join(tmpVerifyRoot, 'sidecar-data');
    mkdirSync(isolatedAgDir, { recursive: true });
    mkdirSync(isolatedCliDir, { recursive: true });
    mkdirSync(isolatedStateDir, { recursive: true });

    process.env.AG_DIR = isolatedAgDir;
    process.env.AG_CLI_DIR = isolatedCliDir;
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = isolatedStateDir;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;

    const {
      collectTokenHistory,
      DEFAULT_SHORTCUT_MAC,
      DEFAULT_SHORTCUT_OTHER,
      formatShortcutDisplay,
      getDefaultShortcut,
      getShortcutConfig,
      listRecentConversations,
      normalizeShortcutSpec,
      parseModelSettingFromText,
      scanConversation,
      setMenubarPreference,
      setShortcutConfig,
      shortcutToMacCarbon
    } = await import(join(ROOT, 'sidecars', 'dashboard', 'collector.mjs'));

    // R6: Model version decimals, parentheses & multi-switch sequences
    assert(
      parseModelSettingFromText('Model Selection from Gemini 4 Carbon to Gemini 3.8 Flash.') === 'Gemini 3.8 Flash',
      'R6 Gemini 3.8 Flash 小数点被截断'
    );
    assert(
      parseModelSettingFromText('Model Selection from Claude Sonnet 5.5 to Gemini 3.1 Pro (High). No need to comment on the model change.') === 'Gemini 3.1 Pro (High)',
      'R6 Gemini 3.1 Pro (High) 解析异常'
    );
    assert(
      parseModelSettingFromText(
        'Model Selection from Gemini 2.5 Pro to Claude Sonnet 5.5.\nLater: Model Selection from Claude Sonnet 5.5 to Claude Opus 5.5.'
      ) === 'Claude Opus 5.5',
      'R6 多次模型切换未保留最后一次完整名称'
    );

    // R5: Offline transcript with per-step `model` field and no "Model Selection" text
    const convId = 'a1b2c3d4e5f60001';
    const logDir = join(isolatedAgDir, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    const transcriptLines = [
      JSON.stringify({
        step_index: 1,
        type: 'USER_INPUT',
        created_at: '2026-11-12T08:00:00Z',
        content: 'Verify offline model attribution'
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-12T08:00:04Z',
        model: 'Gemini 4 Carbon',
        content: 'First answer',
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_tokens: 200
      }),
      JSON.stringify({
        step_index: 3,
        type: 'USER_INPUT',
        created_at: '2026-11-12T08:05:00Z',
        content: 'Switch model on turn 2'
      }),
      JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-12T08:05:03Z',
        model: 'Gemini 3.8 Flash',
        content: 'Second answer',
        usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0 }
      })
    ];
    writeFileSync(join(logDir, 'transcript.jsonl'), `${transcriptLines.join('\n')}\n`, 'utf-8');

    const offlineCtx = await scanConversation(convId, { force: true });
    const offlineHist = await collectTokenHistory({ force: true });
    assert(offlineCtx.context?.modelKey === 'gemini-3.8-flash', `R5 当前会话最新模型识别异常：${offlineCtx.context?.modelKey}`);
    const turn1 = offlineCtx.turns.find((t) => t.turnIndex === 1);
    const turn2 = offlineCtx.turns.find((t) => t.turnIndex === 2);
    assert(turn1?.modelKey === 'gemini-4-carbon' && turn1?.isPriced && turn1.costUSD > 0, 'R5 第 1 轮离线模型计费缺失');
    assert(turn2?.modelKey === 'gemini-3.8-flash' && turn2?.isPriced && turn2.costUSD > 0, 'R5 第 2 轮切换后离线模型计费缺失');
    const sessionIdentifiedUSD = Number(offlineCtx.context?.sessionCostUSD || 0);
    const histIdentifiedUSD = Number(offlineHist.analyticsBySource?.all?.costs?.allTime?.identified?.pricedCostUSD || 0);
    assert(
      sessionIdentifiedUSD > 0 &&
        Math.abs(sessionIdentifiedUSD - histIdentifiedUSD) < 1e-6,
      `R5 会话费用 (${sessionIdentifiedUSD}) 与全局历史费用 (${histIdentifiedUSD}) 不一致`
    );

    // F2: Generalized usage steps (e.g. MODEL_RESPONSE) must not double-count into pendingTokens
    const f2ConvId = 'f2b2c3d4e5f60002';
    const f2LogDir = join(isolatedAgDir, 'brain', f2ConvId, '.system_generated', 'logs');
    mkdirSync(f2LogDir, { recursive: true });
    const f2BaseLines = [
      JSON.stringify({
        step_index: 1,
        type: 'USER_INPUT',
        created_at: '2026-11-12T09:00:00Z',
        content: 'Hello'
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-12T09:00:02Z',
        model: 'Gemini 4 Carbon',
        input_tokens: 100,
        output_tokens: 10,
        content: 'Hi'
      }),
      JSON.stringify({
        step_index: 3,
        type: 'USER_INPUT',
        created_at: '2026-11-12T09:01:00Z',
        content: 'a'.repeat(400)
      }),
      JSON.stringify({
        step_index: 4,
        type: 'MODEL_RESPONSE',
        created_at: '2026-11-12T09:01:05Z',
        model: 'Gemini 3.8 Flash',
        usage: { inputTokens: 1000, outputTokens: 100 },
        content: 'b'.repeat(400)
      })
    ];
    writeFileSync(join(f2LogDir, 'transcript.jsonl'), `${f2BaseLines.join('\n')}\n`, 'utf-8');
    const f2DoneCtx = await scanConversation(f2ConvId, { force: true });
    assert(f2DoneCtx.turns.length === 2, `F2 泛化 usage 步骤未生成第 2 轮 turn，实际 ${f2DoneCtx.turns.length}`);
    assert(
      f2DoneCtx.context?.actual === 1100 &&
        f2DoneCtx.context?.pendingTokens === 0 &&
        f2DoneCtx.context?.pendingStepsCount === 0 &&
        f2DoneCtx.context?.used === 1100,
      `F2 已完成泛化 usage 轮次被重复计入 pendingTokens：actual=${f2DoneCtx.context?.actual}, pending=${f2DoneCtx.context?.pendingTokens}, used=${f2DoneCtx.context?.used}`
    );
    const f2RecentItem = listRecentConversations(24).find((c) => c.id === f2ConvId);
    assert(
      f2RecentItem?.turnsCount === 2 && f2RecentItem?.lastContextTokens === 1100,
      `F2 listRecentConversations 未同步泛化 usage 轮次：turns=${f2RecentItem?.turnsCount}, last=${f2RecentItem?.lastContextTokens}`
    );

    // F2b: Real unsent USER_INPUT after last turn must count in pendingTokens while ERROR_MESSAGE is excluded,
    // and switching to an unlisted model must clear currentModelKey to null instead of inheriting previous turn's key.
    const f2AppendedLines = [
      ...f2BaseLines,
      JSON.stringify({
        step_index: 5,
        type: 'USER_INPUT',
        created_at: '2026-11-12T09:02:00Z',
        content: `${'c'.repeat(200)}\nModel Selection from Gemini 3.8 Flash to Unlisted Experimental Model.`
      }),
      JSON.stringify({
        step_index: 6,
        type: 'ERROR_MESSAGE',
        created_at: '2026-11-12T09:02:01Z',
        content: 'd'.repeat(400)
      })
    ];
    writeFileSync(join(f2LogDir, 'transcript.jsonl'), `${f2AppendedLines.join('\n')}\n`, 'utf-8');
    const f2PendingCtx = await scanConversation(f2ConvId, { force: true });
    assert(
      f2PendingCtx.context?.pendingStepsCount === 1 &&
        f2PendingCtx.context?.pendingTokens > 0 &&
        f2PendingCtx.context?.used === 1100 + f2PendingCtx.context.pendingTokens,
      `F2 未发送 USER_INPUT 与 ERROR_MESSAGE 过滤计算异常：steps=${f2PendingCtx.context?.pendingStepsCount}, pending=${f2PendingCtx.context?.pendingTokens}`
    );
    assert(
      f2PendingCtx.context?.model === 'Unlisted Experimental Model' && f2PendingCtx.context?.modelKey === null,
      `F2 切换未知模型后残留旧 modelKey：model=${f2PendingCtx.context?.model}, key=${f2PendingCtx.context?.modelKey}`
    );
    rmSync(join(isolatedAgDir, 'brain', f2ConvId), { recursive: true, force: true });

    // R3: Mock Language Server quota mutation must invalidate ETag; unchanged poll must keep ETag stable
    let mockRemainingFraction = 0.9;
    const mockLsServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.url?.includes('GetUserStatus')) {
        res.end(JSON.stringify({
          userStatus: {
            userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 4 Carbon',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M400' },
                  quotaInfo: { poolId: 'g-carbon', remainingFraction: 0.8, resetTime: '2026-11-12T14:00:00Z' }
                },
                {
                  label: 'Gemini 3.8 Flash',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
                  quotaInfo: { poolId: 'g-flash', remainingFraction: mockRemainingFraction, resetTime: '2026-11-12T14:00:00Z' }
                }
              ]
            }
          }
        }));
        return;
      }
      if (req.url?.includes('RetrieveUserQuotaSummary')) {
        res.end(JSON.stringify({
          groups: [
            {
              groupId: 'g-carbon',
              displayName: 'Gemini Group A',
              modelIds: ['MODEL_PLACEHOLDER_M400'],
              buckets: [{ bucketId: 'g-carbon-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-11-12T14:00:00Z' }]
            },
            {
              groupId: 'g-flash',
              displayName: 'Gemini Group B',
              modelIds: ['MODEL_PLACEHOLDER_M318'],
              buckets: [{ bucketId: 'g-flash-5h', window: '5h', remainingFraction: mockRemainingFraction, resetTime: '2026-11-12T14:00:00Z' }]
            }
          ]
        }));
        return;
      }
      res.end('{}');
    });
    await new Promise((r) => mockLsServer.listen(0, '127.0.0.1', r));
    try {
      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${mockLsServer.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'mock-ls-csrf';

      const c90 = await scanConversation(convId, { force: true });
      const h90 = await collectTokenHistory({ force: true });
      const flashPool90 = c90.quotas?.find((p) => p.families.includes('Gemini 3.8 Flash'));
      const histFlashPool90 = h90.modelQuotas?.find((p) => p.families.includes('Gemini 3.8 Flash'));
      assert(
        c90.quotas?.length === 2 &&
          flashPool90?.remainingPercent === 90 &&
          histFlashPool90?.remainingPercent === 90 &&
          c90.context?.quota?.remainingPercent === 90,
        'R3/F1 初始 90% Flash 配额池未精确命中'
      );

      const c90Repeat = await scanConversation(convId, { force: true });
      const h90Repeat = await collectTokenHistory({ force: true });
      assert(c90Repeat.etag === c90.etag && h90Repeat.etag === h90.etag, 'R3 数据未变化时 ETag 不应随扫描时间抖动');

      mockRemainingFraction = 0.2;
      const c20 = await scanConversation(convId, { force: true });
      const h20 = await collectTokenHistory({ force: true });
      const flashPool20 = c20.quotas?.find((p) => p.families.includes('Gemini 3.8 Flash'));
      const carbonPool80 = c20.quotas?.find((p) => p.families.includes('Gemini 4 Carbon'));
      const histFlashPool20 = h20.modelQuotas?.find((p) => p.families.includes('Gemini 3.8 Flash'));
      assert(
        carbonPool80?.remainingPercent === 80 &&
          flashPool20?.remainingPercent === 20 &&
          histFlashPool20?.remainingPercent === 20 &&
          c20.context?.quota?.remainingPercent === 20,
        `R3/F1 更新后 Carbon(80%)/Flash(20%) 双池与当前会话配额未同步：ctxQuota=${c20.context?.quota?.remainingPercent}`
      );
      assert(c20.etag !== c90.etag, 'R3 会话配额 90% -> 20% 变化后 context ETag 未更新');
      assert(h20.etag !== h90.etag, 'R3 历史配额 90% -> 20% 变化后 history ETag 未更新');
      var f1LiveSnap20 = c20;
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => mockLsServer.close(r));
    }

    // T2: Language Server failure / partial degradation / continued outage / recovery state machine & ETag
    let t2Mode = 'error'; // 'error' -> 'live' -> 'summary-fail' -> 'error' -> 'live'
    const t2LsServer = http.createServer((req, res) => {
      if (t2Mode === 'error') {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"ls unavailable"}');
        return;
      }
      if (req.url?.includes('GetUserStatus')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          userStatus: {
            userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 3.8 Flash',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
                  quotaInfo: { poolId: 'g-flash', remainingFraction: 0.8, resetTime: '2026-11-12T14:00:00Z' }
                }
              ]
            }
          }
        }));
        return;
      }
      if (req.url?.includes('RetrieveUserQuotaSummary')) {
        if (t2Mode === 'summary-fail') {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"error":"summary unavailable"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          groups: [
            {
              groupId: 'g-flash',
              displayName: 'Gemini Flash Pool',
              modelIds: ['MODEL_PLACEHOLDER_M318'],
              buckets: [
                { bucketId: 'g-flash-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-11-12T14:00:00Z' },
                { bucketId: 'g-flash-wk', window: 'weekly', remainingFraction: 0.6, resetTime: '2026-11-16T00:00:00Z' }
              ]
            }
          ]
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{}');
    });
    await new Promise((r) => t2LsServer.listen(0, '127.0.0.1', r));
    try {
      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${t2LsServer.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 't2-ls-csrf';

      // 1) Cold-start failure before any good snapshot -> error state, empty quotas
      const cColdErr = await scanConversation(convId, { force: true });
      const hColdErr = await collectTokenHistory({ force: true });
      assert(
        cColdErr.quotaStatus?.state === 'error' &&
          cColdErr.quotaStatus?.stale === false &&
          cColdErr.quotaStatus?.lastSuccessAt === null &&
          cColdErr.quotas?.length === 0 &&
          hColdErr.quotaStatus?.state === 'error',
        `T2 冷启动 LS 失败状态异常：${JSON.stringify(cColdErr.quotaStatus)}`
      );

      // 2) Healthy live sync -> state 'live', ETag changes from cold error, repeat poll keeps ETag stable
      t2Mode = 'live';
      const cLive1 = await scanConversation(convId, { force: true });
      const hLive1 = await collectTokenHistory({ force: true });
      assert(
        cLive1.quotaStatus?.state === 'live' &&
          cLive1.quotaStatus?.stale === false &&
          cLive1.quotaStatus?.summaryStale === false &&
          Boolean(cLive1.quotaStatus?.lastSuccessAt) &&
          cLive1.etag !== cColdErr.etag &&
          hLive1.etag !== hColdErr.etag,
        `T2 恢复 live 后状态或 ETag 异常：${JSON.stringify(cLive1.quotaStatus)}`
      );
      const cLive2 = await scanConversation(convId, { force: true });
      const hLive2 = await collectTokenHistory({ force: true });
      assert(
        cLive2.etag === cLive1.etag && hLive2.etag === hLive1.etag,
        'T2 无业务与状态变化时重复轮询不应因当前时间抖动 ETag'
      );

      // 3) Partial failure (RetrieveUserQuotaSummary 503, GetUserStatus 200) -> state 'degraded', ETag updates
      t2Mode = 'summary-fail';
      const cDeg = await scanConversation(convId, { force: true });
      const hDeg = await collectTokenHistory({ force: true });
      assert(
        cDeg.quotaStatus?.state === 'degraded' &&
          cDeg.quotaStatus?.summaryStale === true &&
          cDeg.quotaStatus?.stale === false &&
          cDeg.etag !== cLive2.etag &&
          hDeg.etag !== hLive2.etag,
        `T2 单接口失败未进入 degraded 或未更新 ETag：${JSON.stringify(cDeg.quotaStatus)}`
      );

      // Re-establish clean full live snapshot before testing full outage retention
      t2Mode = 'live';
      const cPreOutage = await scanConversation(convId, { force: true });
      const hPreOutage = await collectTokenHistory({ force: true });
      const preOutageTs = hPreOutage.quotaStatus?.lastSuccessAt;
      assert(Boolean(preOutageTs), 'T2 故障前成功时间缺失');

      // 4) Full outage (both endpoints 503) -> retains cached quota as reference, marks stale:true, preserves lastSuccessAt, updates ETag
      t2Mode = 'error';
      await new Promise((r) => setTimeout(r, 15));
      const cStale1 = await scanConversation(convId, { force: true });
      const hStale1 = await collectTokenHistory({ force: true });
      assert(
        cStale1.quotaStatus?.state === 'stale' &&
          cStale1.quotaStatus?.stale === true &&
          cStale1.quotaStatus?.source === 'cache' &&
          cStale1.quotaStatus?.lastSuccessAt === preOutageTs &&
          cStale1.quotas?.[0]?.remainingPercent === 80 &&
          cStale1.etag !== cPreOutage.etag &&
          hStale1.etag !== hPreOutage.etag,
        `T2 全接口失败未标记 stale 或未保留上次成功时间与缓存额度：${JSON.stringify(cStale1.quotaStatus)}`
      );

      // 5) Continued outage -> preserves original lastSuccessAt and keeps stale ETag stable
      await new Promise((r) => setTimeout(r, 15));
      const cStale2 = await scanConversation(convId, { force: true });
      const hStale2 = await collectTokenHistory({ force: true });
      assert(
        cStale2.quotaStatus?.lastSuccessAt === preOutageTs &&
          cStale2.etag === cStale1.etag &&
          hStale2.etag === hStale1.etag,
        'T2 持续故障期间不应覆盖上次成功时间或抖动 ETag'
      );

      // Verify UI stale & recovery rendering via app.js VM harness
      const t2Harness = createAppRenderHarness();
      t2Harness.vmCtx.renderCostPanel(hStale1);
      assert(
        !t2Harness.getEl('quota-sync-pill').classList.contains('hidden') &&
          t2Harness.getEl('quota-sync-pill').textContent.includes('缓存快照') &&
          t2Harness.getEl('plan-kv').innerHTML.includes('展示上次缓存'),
        `T2 Tab3 未渲染过期缓存提示：${t2Harness.getEl('quota-sync-pill').textContent}`
      );
      t2Harness.vmCtx.renderSpeedCard(cStale1.speed, cStale1.context, [], cStale1.quotaStatus);
      assert(
        t2Harness.getEl('ctx-quota-title').textContent.includes('缓存'),
        `T2 Tab1 未渲染配额缓存标识：${t2Harness.getEl('ctx-quota-title').textContent}`
      );

      // 6) Recovery -> clears stale, advances lastSuccessAt, updates ETag, hides UI stale pill
      await new Promise((r) => setTimeout(r, 15));
      t2Mode = 'live';
      const cRecov = await scanConversation(convId, { force: true });
      const hRecov = await collectTokenHistory({ force: true });
      assert(
        cRecov.quotaStatus?.state === 'live' &&
          cRecov.quotaStatus?.stale === false &&
          Date.parse(cRecov.quotaStatus.lastSuccessAt) > Date.parse(preOutageTs) &&
          cRecov.etag !== cStale1.etag &&
          hRecov.etag !== hStale1.etag,
        `T2 服务恢复后未清除 stale 或未更新成功时间：${JSON.stringify(cRecov.quotaStatus)}`
      );
      t2Harness.vmCtx.renderCostPanel(hRecov);
      assert(
        t2Harness.getEl('quota-sync-pill').classList.contains('hidden'),
        'T2 服务恢复后未隐藏过期提示标签'
      );
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => t2LsServer.close(r));
    }

    // T3: Unknown model context window budget vs user benchmark vs server maxContextTokens
    const t3ConvId = 'f3c3d4e5f6a70003';
    const t3LogDir = join(isolatedAgDir, 'brain', t3ConvId, '.system_generated', 'logs');
    mkdirSync(t3LogDir, { recursive: true });
    writeFileSync(
      join(t3LogDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 1,
          type: 'USER_INPUT',
          created_at: '2026-11-12T10:00:00Z',
          content: 'Check unknown model window capacity'
        }),
        JSON.stringify({
          step_index: 2,
          type: 'MODEL_RESPONSE',
          created_at: '2026-11-12T10:00:05Z',
          model: 'Unknown Review Model',
          usage: { inputTokens: 100000, outputTokens: 1000 },
          content: 'Completed turn without maxContextTokens'
        })
      ].join('\n') + '\n',
      'utf-8'
    );

    // T3a: Offline / no server maxContextTokens -> used=101000 preserved, budget/remaining/percent are null (NEVER 256000)
    const t3Offline = await scanConversation(t3ConvId, { force: true });
    assert(
      t3Offline.context?.used === 101000 &&
        t3Offline.context?.budget === null &&
        t3Offline.context?.budgetSource === 'unknown' &&
        t3Offline.context?.remaining === null &&
        t3Offline.context?.percent === null,
      `T3 无服务端容量依据时不应硬编码 256000：${JSON.stringify(t3Offline.context)}`
    );
    const t3Harness = createAppRenderHarness();
    t3Harness.vmCtx.state.contextData = t3Offline;
    t3Harness.vmCtx.renderTopCapsules();
    t3Harness.vmCtx.renderContextPanel(t3Offline);
    assert(
      t3Harness.getEl('ctx-used').textContent === '101.0K' &&
        t3Harness.getEl('ctx-budget').textContent === '未知' &&
        t3Harness.getEl('ctx-rem').textContent === '--' &&
        t3Harness.getEl('ctx-pct-big').textContent === '--%' &&
        t3Harness.getEl('ctx-health-pill').textContent === '容量未知' &&
        !t3Harness.getEl('ctx-takeaway').textContent.includes('窗口健康'),
      `T3 Auto 模式未知容量 UI 误显示硬编码上限或运行健康：pill=${t3Harness.getEl('ctx-health-pill').textContent}, budget=${t3Harness.getEl('ctx-budget').textContent}`
    );

    // T3b: User explicitly picks 256K comparison benchmark -> computes 39.5% & clearly labels as user benchmark
    t3Harness.vmCtx.state.ui.budgetOverride = 256000;
    t3Harness.vmCtx.renderContextPanel(t3Offline);
    assert(
      t3Harness.getEl('ctx-pct-big').textContent === '39.5%' &&
        t3Harness.getEl('ctx-budget').textContent === '256.0K' &&
        t3Harness.getEl('ctx-budget-sub').textContent.includes('用户对比基准') &&
        t3Harness.getEl('ctx-health-pill').textContent === '按对比基准',
      `T3 用户手动基准模式未与服务端真实阈值区分：sub=${t3Harness.getEl('ctx-budget-sub').textContent}, pill=${t3Harness.getEl('ctx-health-pill').textContent}`
    );

    // T3c: Server GetCascadeTrajectoryGeneratorMetadata provides maxContextTokens=200000 -> server budget=200000, 50.5%
    const t3GenServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.url?.includes('GetCascadeTrajectoryGeneratorMetadata')) {
        res.end(JSON.stringify({
          generatorMetadata: [
            {
              stepIndices: [2],
              chatModel: {
                model: 'Unknown Review Model',
                usage: { inputTokens: 100000, outputTokens: 1000 },
                chatStartMetadata: {
                  contextWindowMetadata: {
                    maxContextTokens: 200000,
                    estimatedTokensUsed: 101000
                  }
                }
              }
            }
          ]
        }));
        return;
      }
      res.end('{}');
    });
    await new Promise((r) => t3GenServer.listen(0, '127.0.0.1', r));
    try {
      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${t3GenServer.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 't3-ls-csrf';
      const t3ServerSnap = await scanConversation(t3ConvId, { force: true });
      assert(
        t3ServerSnap.context?.budget === 200000 &&
          t3ServerSnap.context?.budgetSource === 'server' &&
          t3ServerSnap.context?.used === 101000 &&
          t3ServerSnap.context?.remaining === 99000 &&
          t3ServerSnap.context?.percent === 50.5,
        `T3 服务端返回 maxContextTokens=200000 时计算异常：${JSON.stringify(t3ServerSnap.context)}`
      );
      t3Harness.vmCtx.state.ui.budgetOverride = 0;
      t3Harness.vmCtx.renderContextPanel(t3ServerSnap);
      assert(
        t3Harness.getEl('ctx-budget').textContent === '200.0K' &&
          t3Harness.getEl('ctx-pct-big').textContent === '50.5%' &&
          t3Harness.getEl('ctx-health-pill').textContent === '运行健康',
        'T3 服务端真实上限 Auto 模式渲染异常'
      );

      // U1: Manual benchmark must NEVER mask or fabricate real server health alerts
      const u1NearFullSnap = {
        ...t3ServerSnap,
        context: {
          ...t3ServerSnap.context,
          used: 190000,
          budget: 200000,
          budgetSource: 'server',
          remaining: 10000,
          percent: 95
        }
      };
      t3Harness.vmCtx.state.contextData = u1NearFullSnap;
      t3Harness.vmCtx.state.ui.budgetOverride = 1000000;
      t3Harness.vmCtx.renderTopCapsules();
      t3Harness.vmCtx.renderContextPanel(u1NearFullSnap);
      assert(
        t3Harness.getEl('ctx-pct-big').textContent === '19.0%' &&
          t3Harness.getEl('ctx-budget-sub').textContent.includes('服务端默认 200.0K') &&
          t3Harness.getEl('ctx-health-pill').textContent === '临近上限' &&
          t3Harness.getEl('ctx-health-pill').className.includes('danger') &&
          t3Harness.getEl('hero-ring-fill').style.stroke === 'var(--danger)' &&
          t3Harness.getEl('mini-ring-fill').style.stroke === 'var(--danger)' &&
          t3Harness.getEl('ctx-takeaway').classList.contains('danger') &&
          t3Harness.getEl('ctx-takeaway').textContent.includes('95.0%') &&
          !t3Harness.getEl('ctx-takeaway').textContent.includes('上下文容量充裕'),
        `U1 真实 95% 被 1M 对比基准掩盖：pill=${t3Harness.getEl('ctx-health-pill').textContent}, takeaway=${t3Harness.getEl('ctx-takeaway').textContent}`
      );
      // U1 reverse: real 19% (1M server) + 200K override must remain healthy instead of false danger alert
      const u1LowRatioSnap = {
        ...t3ServerSnap,
        context: {
          ...t3ServerSnap.context,
          used: 190000,
          budget: 1000000,
          budgetSource: 'server',
          remaining: 810000,
          percent: 19
        }
      };
      t3Harness.vmCtx.state.contextData = u1LowRatioSnap;
      t3Harness.vmCtx.state.ui.budgetOverride = 200000;
      t3Harness.vmCtx.renderTopCapsules();
      t3Harness.vmCtx.renderContextPanel(u1LowRatioSnap);
      assert(
        t3Harness.getEl('ctx-pct-big').textContent === '95.0%' &&
          t3Harness.getEl('ctx-health-pill').textContent === '运行健康' &&
          t3Harness.getEl('hero-ring-fill').style.stroke === 'var(--cv-accent)' &&
          !t3Harness.getEl('ctx-takeaway').classList.contains('danger') &&
          !t3Harness.getEl('ctx-takeaway').classList.contains('warn') &&
          t3Harness.getEl('ctx-takeaway').textContent.includes('19.0%'),
        `U1 反向组合（真实 19% + 200K 基准）产生误告警：pill=${t3Harness.getEl('ctx-health-pill').textContent}`
      );
      // U1 equal: 200K server + 200K override should behave as direct 95% alert without redundant note
      t3Harness.vmCtx.state.contextData = u1NearFullSnap;
      t3Harness.vmCtx.state.ui.budgetOverride = 200000;
      t3Harness.vmCtx.renderContextPanel(u1NearFullSnap);
      assert(
        t3Harness.getEl('ctx-health-pill').textContent === '临近上限' &&
          t3Harness.getEl('ctx-takeaway').classList.contains('danger') &&
          !t3Harness.getEl('ctx-takeaway').textContent.includes('对比基准折算'),
        `U1 同容量覆盖不应附带冗余折算提示：${t3Harness.getEl('ctx-takeaway').textContent}`
      );
      t3Harness.vmCtx.state.ui.budgetOverride = 0;
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => t3GenServer.close(r));
      rmSync(join(isolatedAgDir, 'brain', t3ConvId), { recursive: true, force: true });
    }

    // U2: Switching models must NEVER inherit the previous model's server budget
    const u2ConvId = 'b2000000-0000-4000-8000-000000000002';
    const u2LogDir = join(isolatedAgDir, 'brain', u2ConvId, '.system_generated', 'logs');
    mkdirSync(u2LogDir, { recursive: true });
    let u2Phase = 1;
    const u2Server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.url?.includes('GetCascadeTrajectoryGeneratorMetadata')) {
        const meta = [
          {
            stepIndices: [1],
            chatModel: {
              model: 'Claude Sonnet 4.6',
              usage: { inputTokens: 15000, outputTokens: 1000 },
              chatStartMetadata: {
                contextWindowMetadata: { maxContextTokens: 200000, estimatedTokensUsed: 16000 }
              }
            }
          }
        ];
        if (u2Phase >= 2) {
          meta.push({
            stepIndices: [3],
            chatModel: {
              model: 'Custom Unknown B',
              usage: { inputTokens: 49000, outputTokens: 1000 },
              chatStartMetadata: {
                contextWindowMetadata: { estimatedTokensUsed: 50000 }
              }
            }
          });
        }
        if (u2Phase >= 4) {
          meta.push({
            stepIndices: [5],
            chatModel: {
              model: 'Claude Opus 5.5',
              usage: { inputTokens: 58000, outputTokens: 2000 },
              chatStartMetadata: {
                contextWindowMetadata: { maxContextTokens: 1000000, estimatedTokensUsed: 60000 }
              }
            }
          });
        }
        res.end(JSON.stringify({ generatorMetadata: meta }));
        return;
      }
      res.end('{}');
    });
    await new Promise((r) => u2Server.listen(0, '127.0.0.1', r));
    try {
      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${u2Server.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'u2-ls-csrf';
      const writeU2Steps = (steps) => {
        writeFileSync(
          join(u2LogDir, 'transcript.jsonl'),
          steps.map((s) => JSON.stringify(s)).join('\n') + '\n',
          'utf-8'
        );
      };
      // Phase 1: Switch from Claude Sonnet 4.6 (200K) to Custom Unknown B before Unknown B responds
      writeU2Steps([
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'start with sonnet' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:00:05Z', model: 'Claude Sonnet 4.6', content: 'sonnet reply' },
        { step_index: 2, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:01:00Z', content: 'Model Selection from Claude Sonnet 4.6 to Custom Unknown B.\nhi unknown b' }
      ]);
      const u2Snap1 = await scanConversation(u2ConvId, { force: true });
      assert(
        u2Snap1.context?.model === 'Custom Unknown B' &&
          u2Snap1.context?.budget === null &&
          u2Snap1.context?.budgetSource === 'unknown' &&
          u2Snap1.context?.percent === null,
        `U2 切换至未知模型(未出轮次)竟继承上一模型预算：${JSON.stringify(u2Snap1.context)}`
      );

      // Phase 2: Unknown B responds without maxContextTokens (latestValidTurn is still Model A!)
      u2Phase = 2;
      writeU2Steps([
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'start with sonnet' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:00:05Z', model: 'Claude Sonnet 4.6', content: 'sonnet reply' },
        { step_index: 2, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:01:00Z', content: 'Model Selection from Claude Sonnet 4.6 to Custom Unknown B.\nhi unknown b' },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:01:10Z', model: 'Custom Unknown B', content: 'unknown b reply' }
      ]);
      const u2Snap2 = await scanConversation(u2ConvId, { force: true });
      assert(
        u2Snap2.context?.model === 'Custom Unknown B' &&
          u2Snap2.context?.budget === null &&
          u2Snap2.context?.budgetSource === 'unknown',
        `U2 无预算模型已响应时竟回退继承 Model A 预算：${JSON.stringify(u2Snap2.context)}`
      );

      // Phase 3: Switch to Claude Opus 5.5 before Opus 5.5 responds -> must still be unknown
      u2Phase = 3;
      writeU2Steps([
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'start with sonnet' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:00:05Z', model: 'Claude Sonnet 4.6', content: 'sonnet reply' },
        { step_index: 2, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:01:00Z', content: 'Model Selection from Claude Sonnet 4.6 to Custom Unknown B.\nhi unknown b' },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:01:10Z', model: 'Custom Unknown B', content: 'unknown b reply' },
        { step_index: 4, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:02:00Z', content: 'Model Selection from Custom Unknown B to Claude Opus 5.5.\nhi opus' }
      ]);
      const u2Snap3 = await scanConversation(u2ConvId, { force: true });
      assert(
        u2Snap3.context?.model === 'Claude Opus 5.5' && u2Snap3.context?.budget === null,
        `U2 切至 Opus 5.5 首轮完成前不应伪造预算：${JSON.stringify(u2Snap3.context)}`
      );

      // Phase 4 & 5: Opus 5.5 finishes with 1M budget, then user sends next message on same Opus 5.5 -> retains 1M
      u2Phase = 4;
      writeU2Steps([
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'start with sonnet' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:00:05Z', model: 'Claude Sonnet 4.6', content: 'sonnet reply' },
        { step_index: 2, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:01:00Z', content: 'Model Selection from Claude Sonnet 4.6 to Custom Unknown B.\nhi unknown b' },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:01:10Z', model: 'Custom Unknown B', content: 'unknown b reply' },
        { step_index: 4, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:02:00Z', content: 'Model Selection from Custom Unknown B to Claude Opus 5.5.\nhi opus' },
        { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:02:10Z', model: 'Claude Opus 5.5', content: 'opus reply' },
        { step_index: 6, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:03:00Z', content: 'follow up on same model' }
      ]);
      const u2Snap4 = await scanConversation(u2ConvId, { force: true });
      assert(
        u2Snap4.context?.model === 'Claude Opus 5.5' &&
          u2Snap4.context?.budget === 1000000 &&
          u2Snap4.context?.budgetSource === 'server',
        `U2 同模型后续提问应保留 1M 预算：${JSON.stringify(u2Snap4.context)}`
      );

      // Phase 6: Switching back to earlier Claude Sonnet 4.6 restores its own 200K budget (not Opus's 1M)
      writeU2Steps([
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'start with sonnet' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:00:05Z', model: 'Claude Sonnet 4.6', content: 'sonnet reply' },
        { step_index: 2, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:01:00Z', content: 'Model Selection from Claude Sonnet 4.6 to Custom Unknown B.\nhi unknown b' },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:01:10Z', model: 'Custom Unknown B', content: 'unknown b reply' },
        { step_index: 4, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:02:00Z', content: 'Model Selection from Custom Unknown B to Claude Opus 5.5.\nhi opus' },
        { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:02:10Z', model: 'Claude Opus 5.5', content: 'opus reply' },
        { step_index: 6, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:03:00Z', content: 'follow up on same model' },
        { step_index: 7, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:04:00Z', content: 'Model Selection from Claude Opus 5.5 to Claude Sonnet 4.6.\nback to sonnet' }
      ]);
      const u2Snap5 = await scanConversation(u2ConvId, { force: true });
      assert(
        u2Snap5.context?.model === 'Claude Sonnet 4.6' &&
          u2Snap5.context?.budget === 200000 &&
          u2Snap5.context?.budgetSource === 'server',
        `U2 切回曾运行过的 Sonnet 4.6 应恢复其自身 200K 预算：${JSON.stringify(u2Snap5.context)}`
      );
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => u2Server.close(r));
      rmSync(join(isolatedAgDir, 'brain', u2ConvId), { recursive: true, force: true });
    }

    // Privacy runtime check: synthetic error diagnostics & paths/tokens/emails in turnsPayload must be sanitized
    const privConvId = 'c3000000-0000-4000-8000-000000000003';
    const privLogDir = join(isolatedAgDir, 'brain', privConvId, '.system_generated', 'logs');
    mkdirSync(privLogDir, { recursive: true });
    try {
      const privSteps = [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'run sensitive error test' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'ERROR',
          created_at: '2026-11-12T10:00:05Z',
          model: 'Claude Sonnet 5.5',
          usage: { input_tokens: 1200, output_tokens: 10 },
          content: 'Failed calling https://secret.internal.net/v1 with Bearer secret_bearer_token_1234567890 for /Users/mockuser/secret.txt and leak@mycorp-internal.io'
        }
      ];
      writeFileSync(
        join(privLogDir, 'transcript.jsonl'),
        privSteps.map((s) => JSON.stringify(s)).join('\n') + '\n',
        'utf-8'
      );
      const privSnap = await scanConversation(privConvId, { force: true });
      const privJson = JSON.stringify(privSnap);
      assert(
        !privJson.includes('secret_bearer_token') &&
          !privJson.includes('mockuser') &&
          !privJson.includes('mycorp-internal') &&
          !privJson.includes('secret.internal.net'),
        `运行时快照 turnsPayload/error 仍残留未脱敏诊断片段：${privJson}`
      );
    } finally {
      rmSync(join(isolatedAgDir, 'brain', privConvId), { recursive: true, force: true });
    }

    // R8: Windows PowerShell Unicode-safe Base64 loader shim in non-ASCII + space directory
    const ps1Text = readFileSync(join(ROOT, 'install.ps1'), 'utf-8');
    assert(!/\$TargetDir.*-Encoding\s+ASCII/i.test(ps1Text), 'R8 install.ps1 仍将 $TargetDir 直接以 ASCII 编码写出');
    assert(ps1Text.includes('agy-context-loader.mjs') && ps1Text.includes('ToBase64String'), 'R8 install.ps1 缺少 UTF-8 Base64 loader 入口');
    const unicodePluginDir = join(tmpVerifyRoot, '中文 路径 测试', 'context-viewer');
    const unicodeDashDir = join(unicodePluginDir, 'sidecars', 'dashboard');
    const unicodeBinDir = join(tmpVerifyRoot, '命令 入口 目录');
    mkdirSync(unicodeDashDir, { recursive: true });
    mkdirSync(unicodeBinDir, { recursive: true });
    copyFileSync(join(ROOT, 'plugin.json'), join(unicodePluginDir, 'plugin.json'));
    for (const f of ['sidecar.json', 'package.json', 'pricing.mjs', 'collector.mjs', 'float_window.mjs', 'cli.mjs']) {
      copyFileSync(join(ROOT, 'sidecars', 'dashboard', f), join(unicodeDashDir, f));
    }
    const unicodeCliEntry = join(unicodeDashDir, 'cli.mjs');
    const entryB64 = Buffer.from(unicodeCliEntry, 'utf-8').toString('base64');
    const loaderScript = [
      "import { pathToFileURL } from 'node:url';",
      `const entry = Buffer.from('${entryB64}', 'base64').toString('utf8');`,
      'process.argv[1] = entry;',
      'await import(pathToFileURL(entry).href);',
      ''
    ].join('\n');
    assert(/^[\x00-\x7f]+$/.test(loaderScript), 'R8 生成的 agy-context-loader.mjs 必须为纯 ASCII 字节');
    const loaderPath = join(unicodeBinDir, 'agy-context-loader.mjs');
    writeFileSync(loaderPath, loaderScript, 'ascii');
    const isolatedEnv = {
      ...process.env,
      AG_DIR: isolatedAgDir,
      AG_CLI_DIR: isolatedCliDir,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: isolatedStateDir,
      ANTIGRAVITY_CONVERSATION_ID: '',
      ANTIGRAVITY_LS_ADDRESS: '',
      ANTIGRAVITY_CSRF_TOKEN: ''
    };
    const unicodeHelpOut = execFileSync(process.execPath, [loaderPath, '--help'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      timeout: 10000
    });
    assert(
      unicodeHelpOut.includes('agy-context') && unicodeHelpOut.includes(`(v${manifest.version})`),
      'R8 中文与空格路径下 loader --help 输出或版本号同步异常'
    );
    const unicodeJsonOut = execFileSync(process.execPath, [loaderPath, 'json'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      timeout: 10000
    });
    const unicodeParsed = JSON.parse(unicodeJsonOut);
    assert(unicodeParsed.conversation?.id === convId, 'R8 中文与空格路径下 loader json 执行结果异常');

    console.log('[verify] 6/6 执行菜单栏格式化、CLI、守护热升级 (F4) 及双 HTTP 入口安全与关闭链路回归测试 (R1 / R7 / F3)...');
    const {
      controlFloatWindow,
      createFallbackHttpServer,
      DAEMON_BUILD_ID,
      DAEMON_VERSION,
      formatStatusItemFromSnapshot,
      getFloatWindowStatus
    } = await import(join(ROOT, 'sidecars', 'dashboard', 'float_window.mjs'));
    const f1MenubarQuota = formatStatusItemFromSnapshot(f1LiveSnap20, 'quota');
    assert(
      f1MenubarQuota.title.startsWith('⏳ 5h 20%'),
      `F1 菜单栏 quota 标题误用 Carbon 80% 池而非当前 Flash 20% 池：${f1MenubarQuota.title}`
    );
    const mockSnap = {
      ok: true,
      conversationId: 'conv_verify_sample',
      conversationTitle: '帮我安装 https://github.com/example-org/antigravity-context-monitor-plugin 并对比分析',
      context: {
        model: 'Gemini 4 Carbon (High)',
        used: 110080,
        budget: 256000,
        percent: 43.0,
        quota: {
          label: 'Gemini 4 Carbon',
          remainingPercent: 95.4,
          resetTime: new Date(Date.now() + 68 * 60 * 1000).toISOString()
        }
      },
      speed: { tps: 35.2, duration: 48.9, avgTps: 38.4, peakTps: 131.6 },
      quotas: [
        {
          title: 'Gemini 4 Carbon / Gemini 4 Argon / Gemini 3.8 Flash 配额池',
          families: ['Gemini 4 Carbon', 'Gemini 4 Argon', 'Gemini 3.8 Flash'],
          remainingPercent: 94.2,
          resetTime: new Date(Date.now() + 38 * 60 * 1000).toISOString()
        },
        {
          title: 'Claude Opus 5.5 / Claude Sonnet 5.5 / GPT-OSS 120B 配额池',
          families: ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-OSS 120B'],
          remainingPercent: 90.7,
          resetTime: new Date(Date.now() + 36 * 60 * 1000).toISOString()
        }
      ]
    };
    const fmtCtx = formatStatusItemFromSnapshot(mockSnap, 'context');
    assert(fmtCtx.tooltip.includes('\n\n'), 'tooltip 缺少分段空行间距');
    for (const line of fmtCtx.tooltip.split('\n')) {
      let cols = 0;
      for (const ch of line) cols += (ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1;
      assert(cols <= 38, `tooltip 单行过长易折行（${cols} cols）：${line}`);
    }
    const fmtSpd = formatStatusItemFromSnapshot(mockSnap, 'speed');
    const fmtQ5h = formatStatusItemFromSnapshot(mockSnap, 'quota');
    const fmtQWk = formatStatusItemFromSnapshot({
      ...mockSnap,
      context: {
        ...mockSnap.context,
        quota: { label: 'Pro Weekly', remainingPercent: 82.0, resetTime: new Date(Date.now() + 102 * 3600 * 1000).toISOString() }
      }
    }, 'quota');
    assert(fmtCtx.title === '◈ 43%', `context 模式格式化异常：${fmtCtx.title}`);
    assert(fmtSpd.title === '⚡ 35t/s·49s (均38/峰132)', `speed 模式格式化异常：${fmtSpd.title}`);
    assert(fmtQ5h.title.startsWith('⏳ 5h 95%·1h'), `quota 5h 模式格式化异常：${fmtQ5h.title}`);
    assert(fmtQWk.title.startsWith('⏳ Week 82%·4d'), `quota Week 模式格式化异常：${fmtQWk.title}`);

    // T1 & T3 menu bar formatting checks (weekly-only bucket, unknown quota, 0% quota, unknown context budget)
    const fmtQStandaloneWeek = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotas: [],
      context: {
        ...mockSnap.context,
        quota: {
          label: 'Pro Tier',
          remainingPercent: null,
          fiveHour: null,
          weekly: { remainingPercent: 20, resetTime: new Date(Date.now() + 72 * 3600 * 1000).toISOString() }
        }
      }
    }, 'quota');
    assert(
      fmtQStandaloneWeek.title.startsWith('⏳ Week 20%') && fmtQStandaloneWeek.tooltip.includes('(Week)：20%'),
      `T1 菜单栏独立 weekly 配额显示异常：${fmtQStandaloneWeek.title}`
    );
    const fmtQUnknown = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotas: [{ title: 'Unknown Pool', families: ['Gemini 4 Carbon'], remainingPercent: null, resetTime: null }],
      context: { ...mockSnap.context, quota: { label: 'Gemini 4 Carbon', remainingPercent: null } }
    }, 'quota');
    assert(
      fmtQUnknown.title === '⏳ 额度 --%' &&
        fmtQUnknown.tooltip.includes('余量未知') &&
        !fmtQUnknown.tooltip.includes('100%'),
      `T1 菜单栏未知配额误显示为百分比：${fmtQUnknown.title} / ${fmtQUnknown.tooltip}`
    );
    const fmtQZero = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotas: [{ title: 'Exhausted Pool', families: ['Claude Opus 5.5'], remainingPercent: 0, resetTime: new Date(Date.now() + 25 * 60 * 1000).toISOString() }],
      context: { ...mockSnap.context, quota: { label: 'Claude Opus 5.5', remainingPercent: 0, resetTime: new Date(Date.now() + 25 * 60 * 1000).toISOString() } }
    }, 'quota');
    assert(
      fmtQZero.title.startsWith('⚠ 5h 0%') && fmtQZero.tooltip.includes('0%'),
      `T1 菜单栏真实 0% 配额显示异常：${fmtQZero.title}`
    );
    const fmtCtxNoBudget = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotaStatus: { state: 'stale', stale: true },
      context: { ...mockSnap.context, used: 101000, budget: null, percent: null }
    }, 'context');
    assert(
      fmtCtxNoBudget.title === '◈ 101.0K' &&
        fmtCtxNoBudget.tooltip.includes('上限未知') &&
        fmtCtxNoBudget.tooltip.includes('语言服务离线'),
      `T2/T3 菜单栏未知上限或离线状态显示异常：${fmtCtxNoBudget.title} / ${fmtCtxNoBudget.tooltip}`
    );
    for (const line of fmtCtxNoBudget.tooltip.split('\n')) {
      let cols = 0;
      for (const ch of line) cols += (ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1;
      assert(cols <= 38, `T2/T3 tooltip 单行超宽（${cols} cols）：${line}`);
    }
    const fmtU3Base40 = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotas: [u3Base40Pool],
      context: { ...mockSnap.context, quota: u3Base40ModelQ }
    }, 'quota');
    assert(
      fmtU3Base40.title.startsWith('⏳ 基础 40%') &&
        fmtU3Base40.tooltip.includes('基础 40%') &&
        !fmtU3Base40.tooltip.includes('余量未知'),
      `U3 菜单栏基础 40% + reset-only 5h 被隐藏：${fmtU3Base40.title} / ${fmtU3Base40.tooltip}`
    );
    const fmtU3Base0 = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotas: [u3Base0Pool],
      context: { ...mockSnap.context, quota: u3Base0ModelQ }
    }, 'quota');
    assert(
      fmtU3Base0.title.startsWith('⚠ 基础 0%') && fmtU3Base0.tooltip.includes('基础 0%'),
      `U3 菜单栏基础 0% + reset-only 5h 未触发告警：${fmtU3Base0.title} / ${fmtU3Base0.tooltip}`
    );
    for (const line of [...fmtU3Base40.tooltip.split('\n'), ...fmtU3Base0.tooltip.split('\n')]) {
      let cols = 0;
      for (const ch of line) cols += (ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1;
      assert(cols <= 38, `U3 tooltip 单行超宽（${cols} cols）：${line}`);
    }

    const cliOut = execFileSync(process.execPath, [join(ROOT, 'skills', 'context-viewer', 'scripts', 'status.mjs'), '--json'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      timeout: 15000
    });
    const cliJson = JSON.parse(cliOut);
    assert(cliJson.entrypoints?.sidecarAuxPane?.startsWith('sidecar://'), 'CLI JSON 缺少 sidecar 入口字段');

    // 6a: Standalone HTTP server (`main.mjs --standalone`) full R1 + R7 regression
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [join(ROOT, 'sidecars', 'dashboard', 'main.mjs'), '--standalone', '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: isolatedEnv
      });
      let resolved = false;
      const timer = setTimeout(() => {
        child.kill();
        if (!resolved) rejectPromise(new Error('standalone 服务启动超时'));
      }, 8000);

      child.stdout.on('data', async (chunk) => {
        const line = String(chunk);
        const m = line.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m && !resolved) {
          resolved = true;
          try {
            const port = Number(m[1]);
            const base = `http://127.0.0.1:${port}`;
            await runHttpSecurityAndBoundarySuite(port, 'standalone');
            const [rSide, rCss, rFloat, rEntry] = await Promise.all([
              fetch(`${base}/sidebar`),
              fetch(`${base}/styles.css?v=${manifest.version}`),
              fetch(`${base}/api/float-window`),
              fetch(`${base}/api/entrypoints`)
            ]);
            assert(rSide.status === 200, `GET /sidebar 返回 ${rSide.status}`);
            assert(rCss.status === 200, `GET /styles.css 返回 ${rCss.status}`);
            assert(rFloat.status === 200, `GET /api/float-window 返回 ${rFloat.status}`);
            assert(rEntry.status === 200, `GET /api/entrypoints 返回 ${rEntry.status}`);
            assert(child.exitCode === null, 'standalone 服务在异常请求测试后意外退出');
            clearTimeout(timer);
            child.kill();
            resolvePromise();
          } catch (err) {
            clearTimeout(timer);
            child.kill();
            rejectPromise(err);
          }
        }
      });
    });

    // 6b: Fallback browser-app HTTP server (`float_window.mjs`) full R1 + R7 regression
    let fallbackCloseTriggered = false;
    const fallbackState = {
      daemonRunning: true,
      running: true,
      windowVisible: true,
      pinned: false,
      menubarEnabled: false,
      mode: 'browser-app'
    };
    const { server: fbServer } = createFallbackHttpServer(fallbackState, {
      onCloseRequest: () => { fallbackCloseTriggered = true; }
    });
    await new Promise((r) => fbServer.listen(0, '127.0.0.1', r));
    try {
      const fbPort = fbServer.address().port;
      const { csrfToken: fbToken } = await runHttpSecurityAndBoundarySuite(fbPort, 'fallback-http');

      // F3: Execute actual served fallback bridge + app.js `#btn-float` click listener end-to-end
      const fbHtmlRes = await rawHttpRequest({ port: fbPort, path: '/' });
      const bridgeMatch = fbHtmlRes.body.match(/<script>(window\.__CV_FLOAT_MODE__\s*=\s*true;[\s\S]*?)<\/script>/);
      assert(Boolean(bridgeMatch?.[1]), 'F3 降级 HTML 未注入 window.__CV_FLOAT_MODE__ 桥接脚本');
      const floatHandlerStart = appJsSrc.indexOf("$('btn-float')?.addEventListener('click'");
      const floatHandlerEnd = appJsSrc.indexOf('// CLI Launcher', floatHandlerStart);
      assert(floatHandlerStart > 0 && floatHandlerEnd > floatHandlerStart, 'F3 未定位到 app.js #btn-float 点击事件代码');
      let capturedFloatClick = null;
      let windowCloseCount = 0;
      const fbVmWindow = {
        close: () => { windowCloseCount++; }
      };
      const fbVmCtx = {
        window: fbVmWindow,
        document: {
          querySelector: (sel) => (
            sel === 'meta[name="cv-csrf-token"]'
              ? { getAttribute: (attr) => (attr === 'content' ? fbToken : null) }
              : null
          )
        },
        fetch: (urlPath, opts = {}) => fetch(`http://127.0.0.1:${fbPort}${urlPath}`, {
          ...opts,
          headers: {
            Origin: `http://127.0.0.1:${fbPort}`,
            ...(opts.headers || {})
          }
        }),
        apiFetch: async () => { throw new Error('unexpected fallback apiFetch branch'); },
        $: (id) => (
          id === 'btn-float'
            ? { addEventListener: (evName, fn) => { if (evName === 'click') capturedFloatClick = fn; } }
            : null
        ),
        state: { floatRunning: true, floatPinned: false },
        syncFloatButtonUi: () => {},
        showToast: () => {}
      };
      runInNewContext(`${bridgeMatch[1]}\n${appJsSrc.slice(floatHandlerStart, floatHandlerEnd)}`, fbVmCtx);
      assert(typeof capturedFloatClick === 'function', 'F3 未捕获到 #btn-float click 回调');
      await capturedFloatClick({ shiftKey: false });
      assert(
        fallbackCloseTriggered && windowCloseCount === 1,
        `F3 浏览器降级小窗点击关闭按钮未同时通知后端与关闭窗口：closed=${fallbackCloseTriggered}, winClose=${windowCloseCount}`
      );

      fallbackCloseTriggered = false;
      const rUnauthClose = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/float-window',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      assert(rUnauthClose.status === 403 && !fallbackCloseTriggered, '未授权 POST /api/float-window 不得触发关闭小窗');
      const rAuthClose = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/float-window',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: '{}'
      });
      assert(rAuthClose.status === 200 && fallbackCloseTriggered, '授权 POST /api/float-window 应正常触发关闭回调');

      // Shortcut API CRUD over authenticated /api/entrypoints
      const rSetSc = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/entrypoints',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ target: 'shortcut', accelerator: 'opt+cmd+l', scope: 'global' })
      });
      const setScBody = JSON.parse(rSetSc.body);
      assert(
        rSetSc.status === 200 &&
          setScBody.ok === true &&
          setScBody.shortcut?.accelerator === 'Alt+Meta+L' &&
          setScBody.shortcut?.scope === 'global' &&
          setScBody.shortcut?.enabled === true,
        `POST /api/entrypoints 自定义快捷键返回异常：${rSetSc.body}`
      );

      const rBadSc = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/entrypoints',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ target: 'shortcut', accelerator: 'k' })
      });
      const badScBody = JSON.parse(rBadSc.body);
      assert(
        rBadSc.status === 200 &&
          badScBody.ok === false &&
          badScBody.shortcut?.accelerator === 'Alt+Meta+L',
        `非法单键快捷键应被拒绝且保留原有效配置：${rBadSc.body}`
      );

      const rResetSc = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/entrypoints',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ target: 'shortcut', reset: true })
      });
      const resetScBody = JSON.parse(rResetSc.body);
      assert(
        rResetSc.status === 200 &&
          resetScBody.ok === true &&
          resetScBody.shortcut?.isDefault === true &&
          resetScBody.shortcut?.scope === 'app',
        `POST /api/entrypoints 恢复默认快捷键异常：${rResetSc.body}`
      );
    } finally {
      await new Promise((r) => fbServer.close(r));
    }

    // 6c: F4 daemon hot-upgrade on DAEMON_VERSION / DAEMON_BUILD_ID change + preference preservation
    const isTestPidAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const dummyProcs = [];
    const spawnDummyProc = () => {
      const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
      dummyProcs.push(p);
      return p;
    };
    try {
      const floatStateFile = join(isolatedStateDir, 'float_window_state.json');
      const staleProc = spawnDummyProc();
      const upgradedProc = spawnDummyProc();
      const hotReloadProc = spawnDummyProc();
      setMenubarPreference(true);

      writeFileSync(floatStateFile, JSON.stringify({
        daemonVersion: DAEMON_VERSION - 1,
        daemonBuildId: 'legacy-build-v4',
        daemonRunning: true,
        running: false,
        windowVisible: false,
        pid: staleProc.pid,
        pinned: false,
        menubarEnabled: true,
        menubarMode: 'quota',
        mode: 'native-macos',
        cmdSeq: 1
      }), 'utf-8');

      let spawnCalls = [];
      let nextDummyProc = upgradedProc;
      const mockSpawnDaemon = async (opts) => {
        spawnCalls.push(opts);
        writeFileSync(floatStateFile, JSON.stringify({
          daemonVersion: DAEMON_VERSION,
          daemonBuildId: DAEMON_BUILD_ID,
          daemonRunning: true,
          running: !opts.hiddenWindow,
          windowVisible: !opts.hiddenWindow,
          pid: nextDummyProc.pid,
          pinned: Boolean(opts.pinned),
          menubarEnabled: Boolean(opts.menubarEnabled),
          menubarMode: opts.menubarMode || 'context',
          mode: 'native-macos',
          cmdSeq: 1
        }), 'utf-8');
        return getFloatWindowStatus('darwin');
      };

      const upRes = await controlFloatWindow(
        { action: 'ensure-menubar' },
        { platform: 'darwin', spawnDaemon: mockSpawnDaemon }
      );
      assert(!isTestPidAlive(staleProc.pid), 'F4 旧版守护进程在 ensure-menubar 时未被终止');
      assert(
        spawnCalls.length === 1 &&
          spawnCalls[0].pinned === false &&
          spawnCalls[0].menubarEnabled === true &&
          spawnCalls[0].hiddenWindow === true &&
          spawnCalls[0].menubarMode === 'quota' &&
          upRes.pid === upgradedProc.pid,
        `F4 旧守护热升级未完整保留 pinned/mode 状态：${JSON.stringify(spawnCalls[0])}`
      );

      // Already-current daemon must NOT be restarted on subsequent ensure-menubar calls
      const noopRes = await controlFloatWindow(
        { action: 'ensure-menubar' },
        { platform: 'darwin', spawnDaemon: mockSpawnDaemon }
      );
      assert(
        isTestPidAlive(upgradedProc.pid) && spawnCalls.length === 1 && noopRes.pid === upgradedProc.pid,
        'F4 已是最新版本的守护进程在重复 ensure-menubar 时不应被重启'
      );

      // Code/asset fingerprint change (same DAEMON_VERSION, stale daemonBuildId) must also upgrade on refresh-session
      writeFileSync(floatStateFile, JSON.stringify({
        daemonVersion: DAEMON_VERSION,
        daemonBuildId: 'stale-fingerprint-0000',
        daemonRunning: true,
        running: false,
        windowVisible: false,
        pid: upgradedProc.pid,
        pinned: false,
        menubarEnabled: true,
        menubarMode: 'quota',
        mode: 'native-macos',
        cmdSeq: 2
      }), 'utf-8');
      nextDummyProc = hotReloadProc;
      const reloadRes = await controlFloatWindow(
        { action: 'refresh-session' },
        { platform: 'darwin', spawnDaemon: mockSpawnDaemon }
      );
      assert(
        !isTestPidAlive(upgradedProc.pid) &&
          spawnCalls.length === 2 &&
          spawnCalls[1].pinned === false &&
          spawnCalls[1].menubarMode === 'quota' &&
          reloadRes.pid === hotReloadProc.pid,
        'F4 源码构建指纹变化后 refresh-session 未触发守护平滑重建'
      );
    } finally {
      for (const p of dummyProcs) {
        try { p.kill('SIGKILL'); } catch {}
      }
    }

    // 6d: Customizable Shortcut Normalization, Carbon Keycodes, UI KeyEvent Matching, Resident Lifecycle & Swift Typecheck
    assert(getDefaultShortcut('darwin') === DEFAULT_SHORTCUT_MAC && DEFAULT_SHORTCUT_MAC === 'Alt+Meta+K', 'macOS 默认快捷键应为 Alt+Meta+K');
    assert(getDefaultShortcut('win32') === DEFAULT_SHORTCUT_OTHER && DEFAULT_SHORTCUT_OTHER === 'Ctrl+Alt+K', 'Windows/Linux 默认快捷键应为 Ctrl+Alt+K');
    assert(formatShortcutDisplay('Alt+Meta+K', 'darwin') === '⌥⌘K', 'macOS 快捷键显示符号应为 ⌥⌘K');
    assert(formatShortcutDisplay('Ctrl+Alt+K', 'win32') === 'Ctrl+Alt+K', 'Windows 快捷键显示格式应为 Ctrl+Alt+K');

    const macDefaultCarbon = shortcutToMacCarbon('Alt+Meta+K');
    assert(
      macDefaultCarbon?.keyCode === 40 && macDefaultCarbon?.modifiers === (2048 | 256),
      `Alt+Meta+K Carbon 键码映射异常：${JSON.stringify(macDefaultCarbon)}`
    );

    const normGlyph = normalizeShortcutSpec('⌃⇧⌘Space', 'darwin');
    assert(
      normGlyph.ok &&
        !normGlyph.disabled &&
        normGlyph.accelerator === 'Ctrl+Shift+Meta+Space' &&
        normGlyph.display === '⌃⇧⌘Space' &&
        normGlyph.macCarbon?.keyCode === 49 &&
        normGlyph.macCarbon?.modifiers === (4096 | 512 | 256),
      `紧凑符号快捷键解析异常：${JSON.stringify(normGlyph)}`
    );
    const normFn = normalizeShortcutSpec('f8', 'darwin');
    assert(normFn.ok && normFn.accelerator === 'F8' && normFn.macCarbon?.keyCode === 100, 'F8 功能键解析异常');
    const normOff = normalizeShortcutSpec('off', 'darwin');
    assert(normOff.ok && normOff.disabled === true, 'off 停用指令解析异常');

    for (const bad of ['K', 'Shift+K', 'Meta+Alt', 'Meta+C', 'Meta+Q', 'Meta+Space', 'Shift+Meta+Z', 'Alt+Meta+K+L']) {
      const r = normalizeShortcutSpec(bad, 'darwin');
      assert(!r.ok, `macOS 下非法或系统保留组合键「${bad}」必须被拦截`);
    }
    assert(!normalizeShortcutSpec('Ctrl+C', 'win32').ok, 'Windows 下 Ctrl+C 必须被拦截');

    // Persistence: custom -> off preserves accelerator -> reset restores default
    const savedCustom = setShortcutConfig({ accelerator: 'ctrl+opt+j', scope: 'global' }, 'darwin');
    assert(
      savedCustom.ok &&
        savedCustom.shortcut.accelerator === 'Ctrl+Alt+J' &&
        savedCustom.shortcut.display === '⌃⌥J' &&
        savedCustom.shortcut.scope === 'global' &&
        savedCustom.shortcut.isDefault === false,
      'setShortcutConfig 自定义保存异常'
    );
    const savedDisabled = setShortcutConfig({ accelerator: 'off' }, 'darwin');
    assert(
      savedDisabled.ok &&
        savedDisabled.shortcut.enabled === false &&
        savedDisabled.shortcut.accelerator === 'Ctrl+Alt+J',
      'setShortcutConfig off 停用时应保留原已选键位以便重新启用'
    );
    const savedReenabled = setShortcutConfig({ enabled: true }, 'darwin');
    assert(savedReenabled.ok && savedReenabled.shortcut.enabled === true && savedReenabled.shortcut.accelerator === 'Ctrl+Alt+J', '重新启用快捷键状态异常');
    const savedReset = setShortcutConfig({ reset: true }, 'darwin');
    assert(
      savedReset.ok &&
        savedReset.shortcut.isDefault === true &&
        savedReset.shortcut.accelerator === 'Alt+Meta+K' &&
        savedReset.shortcut.scope === 'app' &&
        getShortcutConfig('darwin').isDefault === true,
      'setShortcutConfig reset 恢复默认异常'
    );

    // UI KeyEvent matching in app.js (verifies macOS Option+Cmd+K dead-character `˚` handling via `ev.code`)
    const scFnStart = appJsSrc.indexOf('const SPECIAL_EVENT_CODES = new Set(');
    const scFnEnd = appJsSrc.indexOf('function startShortcutRecording()', scFnStart);
    assert(scFnStart > 0 && scFnEnd > scFnStart, '未定位到 app.js 快捷键事件解析函数区间');
    const scVmCtx = {
      state: { shortcut: { nativeGlobalSupported: true } },
      Set,
      String,
      Boolean
    };
    runInNewContext(
      `${appJsSrc.slice(scFnStart, scFnEnd)}\nthis.buildAcc = buildAcceleratorFromKeyEvent;\nthis.matchAcc = eventMatchesAccelerator;`,
      scVmCtx
    );
    const macDeadCharEv = {
      code: 'KeyK',
      key: '˚',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: true
    };
    const builtMacChord = scVmCtx.buildAcc(macDeadCharEv);
    assert(
      builtMacChord.ok && builtMacChord.accelerator === 'Alt+Meta+K',
      `macOS Option+Cmd+K 特殊字符事件构建失败：${JSON.stringify(builtMacChord)}`
    );
    assert(
      scVmCtx.matchAcc(macDeadCharEv, 'Alt+Meta+K') === true &&
        scVmCtx.matchAcc({ ...macDeadCharEv, shiftKey: true }, 'Alt+Meta+K') === false,
      'eventMatchesAccelerator 精确修饰键匹配异常'
    );
    const modPreview = scVmCtx.buildAcc({ code: 'AltLeft', key: 'Alt', ctrlKey: false, altKey: true, shiftKey: false, metaKey: true });
    assert(modPreview.modifierOnly === true && modPreview.preview === '⌥⌘…', '录制中纯修饰键实时预览异常');

    // Resident daemon lifecycle when menubar is OFF while shortcut is ON
    const scProcs = [];
    const spawnScDummy = () => {
      const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
      scProcs.push(p);
      return p;
    };
    try {
      const floatStateFile = join(isolatedStateDir, 'float_window_state.json');
      try { rmSync(floatStateFile, { force: true }); } catch {}
      setMenubarPreference(false);
      setShortcutConfig({ reset: true }, 'darwin'); // enabled: true, menubarEnabled: false

      const scDaemonProc = spawnScDummy();
      let scSpawnCount = 0;
      let lastSentCmd = null;
      const mockScSpawn = async (opts) => {
        scSpawnCount += 1;
        writeFileSync(floatStateFile, JSON.stringify({
          daemonVersion: DAEMON_VERSION,
          daemonBuildId: DAEMON_BUILD_ID,
          daemonRunning: true,
          running: !opts.hiddenWindow,
          windowVisible: !opts.hiddenWindow,
          pid: scDaemonProc.pid,
          pinned: Boolean(opts.pinned),
          menubarEnabled: Boolean(opts.menubarEnabled),
          shortcutEnabled: true,
          shortcutAccelerator: 'Alt+Meta+K',
          shortcutScope: 'app',
          menubarMode: opts.menubarMode || 'context',
          mode: 'native-macos',
          cmdSeq: 1
        }), 'utf-8');
        return getFloatWindowStatus('darwin');
      };
      const mockScSendCmd = async (_cur, cmdObj) => {
        lastSentCmd = cmdObj;
        if (cmdObj.cmd === 'hideWindow') {
          const curObj = JSON.parse(readFileSync(floatStateFile, 'utf-8'));
          curObj.windowVisible = false;
          curObj.running = false;
          writeFileSync(floatStateFile, JSON.stringify(curObj), 'utf-8');
        }
        return getFloatWindowStatus('darwin');
      };

      // Menu bar is OFF, shortcut is ON -> ensure-menubar must still spawn hidden resident daemon for hotkey!
      const ensureScOnly = await controlFloatWindow(
        { action: 'ensure-menubar' },
        { platform: 'darwin', spawnDaemon: mockScSpawn, sendDaemonCommand: mockScSendCmd }
      );
      assert(
        scSpawnCount === 1 && ensureScOnly.daemonRunning === true && ensureScOnly.menubarEnabled === false && ensureScOnly.shortcutActive === true,
        `菜单栏关闭但快捷键开启时 ensure-menubar 应启动常驻守护以监听热键：${JSON.stringify(ensureScOnly)}`
      );

      // Mark window visible and call close -> must send hideWindow (NOT terminate daemon) while shortcut is ON
      const visObj = JSON.parse(readFileSync(floatStateFile, 'utf-8'));
      visObj.windowVisible = true;
      visObj.running = true;
      writeFileSync(floatStateFile, JSON.stringify(visObj), 'utf-8');
      const closeKeepResident = await controlFloatWindow(
        { action: 'close' },
        { platform: 'darwin', spawnDaemon: mockScSpawn, sendDaemonCommand: mockScSendCmd }
      );
      assert(
        lastSentCmd?.cmd === 'hideWindow' && isTestPidAlive(scDaemonProc.pid) && closeKeepResident.closed === true,
        '快捷键开启但菜单栏关闭时收回窗口不应杀死原生热键守护进程'
      );

      // When BOTH menubar and shortcut are OFF -> close terminates non-resident daemon, and ensure-menubar does not spawn
      setShortcutConfig({ enabled: false }, 'darwin');
      visObj.shortcutEnabled = false;
      visObj.windowVisible = true;
      visObj.running = true;
      writeFileSync(floatStateFile, JSON.stringify(visObj), 'utf-8');
      await controlFloatWindow(
        { action: 'close' },
        { platform: 'darwin', spawnDaemon: mockScSpawn, sendDaemonCommand: mockScSendCmd }
      );
      assert(!isTestPidAlive(scDaemonProc.pid), '菜单栏与快捷键均关闭时关闭小窗应退出守护进程');

      const noSpawnWhenBothOff = await controlFloatWindow(
        { action: 'ensure-menubar' },
        { platform: 'darwin', spawnDaemon: mockScSpawn, sendDaemonCommand: mockScSendCmd }
      );
      assert(scSpawnCount === 1 && noSpawnWhenBothOff.daemonRunning === false, '菜单栏与快捷键均关闭时 ensure-menubar 不得拉起守护进程');
      setShortcutConfig({ reset: true }, 'darwin');
    } finally {
      for (const p of scProcs) {
        try { p.kill('SIGKILL'); } catch {}
      }
    }

    // CLI shortcut status & validation check in isolated environment
    const cliEntryPath = join(ROOT, 'sidecars', 'dashboard', 'cli.mjs');
    const cliScStatusRaw = execFileSync(process.execPath, [cliEntryPath, 'shortcut', 'status', '--json'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      timeout: 8000
    });
    const cliScStatus = JSON.parse(cliScStatusRaw);
    assert(
      cliScStatus.ok === true && cliScStatus.shortcut?.enabled === true && cliScStatus.shortcut?.isDefault === true,
      `cli.mjs shortcut status --json 输出异常：${cliScStatusRaw}`
    );
    let badCliRejected = false;
    try {
      execFileSync(process.execPath, [cliEntryPath, 'shortcut', 'k'], {
        encoding: 'utf-8',
        env: isolatedEnv,
        stdio: 'pipe',
        timeout: 8000
      });
    } catch (err) {
      badCliRejected = err.status === 1;
    }
    assert(badCliRejected, 'cli.mjs shortcut k 单字母非法快捷键必须返回退出码 1');

    // macOS Swift native host typecheck
    if (process.platform === 'darwin' && existsSync('/usr/bin/swiftc')) {
      execFileSync('/usr/bin/swiftc', ['-typecheck', join(ROOT, 'sidecars', 'dashboard', 'native_float_macos.swift')], {
        stdio: 'pipe',
        timeout: 25000
      });
    }
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpVerifyRoot, { recursive: true, force: true });
  }

  console.log(`[verify] 全部校验通过！当前版本：v${manifest.version}（共检查 ${allFiles.length} 个源码文件）`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
