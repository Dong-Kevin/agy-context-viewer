#!/usr/bin/env node
/**
 * Strict Verification & Privacy Audit Suite for Antigravity Context Viewer.
 * Run before packaging or pushing to GitHub:
 *   node scripts/verify.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function main() {
  console.log('[verify] 1/5 检查 plugin.json 与 sidecar.json 规范...');
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

  console.log('[verify] 2/5 检查全部 JS / MJS 语法...');
  const allFiles = walkFiles(ROOT);
  for (const f of allFiles) {
    if (['.js', '.mjs'].includes(extname(f))) {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    }
  }

  console.log('[verify] 3/5 执行开源隐私审计（个人路径、UUID、Token 泄露检查）...');
  const forbiddenPatterns = [
    { re: /\/Users\/[A-Za-z0-9._-]+/, label: 'macOS 个人主目录绝对路径 (/Users/...)' },
    { re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/, label: 'Windows 个人主目录绝对路径 (C:\\Users\\...)' },
    { re: /\/home\/[a-z0-9._-]+\//, label: 'Linux 个人主目录绝对路径 (/home/...)' },
    { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, label: '会话 UUID 硬编码' },
    { re: /\b(AIza[0-9A-Za-z-_]{35}|ghp_[0-9A-Za-z]{36}|sk-[0-9A-Za-z]{32,})\b/, label: '疑似 API Key / Token' }
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
      assert(!m, `文件 ${rel} 命中敏感内容规则 [${pat.label}]：${m?.[0]}`);
    }
  }

  console.log('[verify] 4/5 检查宿主 CSS 变量命名空间隔离与前端配额池序列化...');
  for (const f of ['styles.css', 'app.js']) {
    const p = join(ROOT, 'sidecars', 'dashboard', f);
    const s = readFileSync(p, 'utf-8');
    const collisions = [...s.matchAll(/var\(--(muted|accent|bg|surface|surface-2|surface-3|fg|fg-2|border-strong)(?![-a-zA-Z0-9_])/g)];
    assert(collisions.length === 0, `${f} 存在未加 --cv- 前缀的易冲突变量引用：${collisions[0]?.[0]}`);
  }
  const appJsSrc = readFileSync(join(ROOT, 'sidecars', 'dashboard', 'app.js'), 'utf-8');
  assert(!/\(pool\.models\s*\|\|\s*\[\]\)\.slice\([^)]*\)\.join\(/.test(appJsSrc), 'app.js 直接对 pool.models 对象数组调用 join 会产生 [object Object]');
  const { groupModelQuotas, parseUserPlanStatus, resolveEffectivePlanStatus } = await import(join(ROOT, 'sidecars', 'dashboard', 'pricing.mjs'));
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

  console.log('[verify] 5/5 执行菜单栏三模式格式化、CLI 与独立 HTTP 服务冒烟测试...');
  const { formatStatusItemFromSnapshot } = await import(join(ROOT, 'sidecars', 'dashboard', 'float_window.mjs'));
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
  const cliOut = execFileSync(process.execPath, [join(ROOT, 'skills', 'context-viewer', 'scripts', 'status.mjs'), '--json'], {
    encoding: 'utf-8',
    timeout: 15000
  });
  const cliJson = JSON.parse(cliOut);
  assert(cliJson.entrypoints?.sidecarAuxPane?.startsWith('sidecar://'), 'CLI JSON 缺少 sidecar 入口字段');

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(ROOT, 'sidecars', 'dashboard', 'main.mjs'), '--standalone', '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let resolved = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!resolved) rejectPromise(new Error('standalone 服务启动超时'));
    }, 6000);

    child.stdout.on('data', async (chunk) => {
      const line = String(chunk);
      const m = line.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !resolved) {
        resolved = true;
        try {
          const base = `http://127.0.0.1:${m[1]}`;
          const [rHtml, rSide, rCss, rSet, rFloat, rEntry] = await Promise.all([
            fetch(`${base}/`),
            fetch(`${base}/sidebar`),
            fetch(`${base}/styles.css?v=${manifest.version}`),
            fetch(`${base}/api/settings`),
            fetch(`${base}/api/float-window`),
            fetch(`${base}/api/entrypoints`)
          ]);
          assert(rHtml.status === 200, `GET / 返回 ${rHtml.status}`);
          assert(rSide.status === 200, `GET /sidebar 返回 ${rSide.status}`);
          assert(rCss.status === 200, `GET /styles.css 返回 ${rCss.status}`);
          assert(rSet.status === 200, `GET /api/settings 返回 ${rSet.status}`);
          assert(rFloat.status === 200, `GET /api/float-window 返回 ${rFloat.status}`);
          assert(rEntry.status === 200, `GET /api/entrypoints 返回 ${rEntry.status}`);
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

  console.log(`[verify] 全部校验通过！当前版本：v${manifest.version}（共检查 ${allFiles.length} 个源码文件）`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
