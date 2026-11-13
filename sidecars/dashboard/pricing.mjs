/**
 * Pricing, Model Normalization, Subscription Presets, and Token Estimation Engine.
 * Zero external dependencies. Read-only computation module.
 */

export const PRICING_VERIFIED_DATE = '2026-11-11';

// Official public API retail pricing (USD per 1M tokens)
export const MODEL_PRICING_TABLE = {
  'gemini-4-carbon': [
    {
      effectiveTo: '2026-11-30',
      inputPerMillion: 2.00,
      outputPerMillion: 10.00,
      cacheReadPerMillion: 0.10,
      note: 'Gemini 4 Carbon 首发期费率（至 2026-11-30）'
    },
    {
      effectiveFrom: '2026-12-01',
      inputPerMillion: 4.00,
      outputPerMillion: 20.00,
      cacheReadPerMillion: 0.20,
      note: 'Gemini 4 Carbon 标准费率'
    }
  ],
  'gemini-4-argon': [
    {
      effectiveTo: '2026-11-30',
      inputPerMillion: 2.00,
      outputPerMillion: 10.00,
      cacheReadPerMillion: 0.10,
      note: 'Gemini 4 Argon 首发期费率（至 2026-11-30）'
    },
    {
      effectiveFrom: '2026-12-01',
      inputPerMillion: 4.00,
      outputPerMillion: 20.00,
      cacheReadPerMillion: 0.20,
      note: 'Gemini 4 Argon 标准费率'
    }
  ],
  'gemini-3.8-flash': [
    {
      effectiveTo: '2026-12-31',
      inputPerMillion: 0.75,
      outputPerMillion: 3.75,
      cacheReadPerMillion: 0.075,
      note: 'Gemini 3.8 Flash 首发期费率（至 2026-12-31）'
    },
    {
      effectiveFrom: '2027-01-01',
      inputPerMillion: 1.50,
      outputPerMillion: 7.50,
      cacheReadPerMillion: 0.15,
      note: 'Gemini 3.8 Flash 标准费率'
    }
  ],
  'claude-opus-5-5': [
    {
      inputPerMillion: 4.00,
      outputPerMillion: 20.00,
      cacheReadPerMillion: 0.20,
      note: 'Claude Opus 5.5 标准费率'
    }
  ],
  'claude-sonnet-5-5': [
    {
      inputPerMillion: 2.00,
      outputPerMillion: 10.00,
      cacheReadPerMillion: 0.10,
      note: 'Claude Sonnet 5.5 标准费率'
    }
  ],
  'gemini-3.1-pro-preview': [
    {
      maxPromptTokens: 200000,
      inputPerMillion: 2.00,
      outputPerMillion: 12.00,
      cacheReadPerMillion: 0.20
    },
    {
      minPromptTokens: 200001,
      inputPerMillion: 4.00,
      outputPerMillion: 18.00,
      cacheReadPerMillion: 0.40
    }
  ],
  'gemini-3.5-flash-lite': [
    {
      inputPerMillion: 0.30,
      outputPerMillion: 2.50,
      cacheReadPerMillion: 0.03
    }
  ],
  'gemini-2.5-pro': [
    {
      maxPromptTokens: 200000,
      inputPerMillion: 1.25,
      outputPerMillion: 10.00,
      cacheReadPerMillion: 0.125
    },
    {
      minPromptTokens: 200001,
      inputPerMillion: 2.50,
      outputPerMillion: 15.00,
      cacheReadPerMillion: 0.25
    }
  ]
};

export const MODEL_DISPLAY_NAMES = {
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'gpt-oss-120b': 'GPT-OSS 120B',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  'gemini-2.5-pro': 'Gemini 2.5 Pro'
};

const PLACEHOLDER_MODEL_MAP = {
  model_placeholder_m427: 'gemini-4-carbon',
  model_placeholder_m437: 'gemini-4-carbon',
  model_placeholder_m438: 'gemini-4-carbon',
  model_placeholder_m417: 'gemini-4-argon',
  model_placeholder_m418: 'gemini-4-argon',
  model_placeholder_m419: 'gemini-4-argon',
  model_placeholder_m318: 'gemini-3.8-flash',
  model_placeholder_m319: 'gemini-3.8-flash',
  model_placeholder_m320: 'gemini-3.8-flash',
  model_placeholder_m400: 'claude-opus-5-5',
  model_placeholder_m401: 'claude-opus-5-5',
  model_placeholder_m402: 'claude-opus-5-5',
  model_placeholder_m403: 'claude-sonnet-5-5',
  model_placeholder_m404: 'claude-sonnet-5-5',
  model_placeholder_m405: 'claude-sonnet-5-5',
  model_openai_gpt_oss_120b_medium: 'gpt-oss-120b'
};

export function normalizeModelId(raw, dynamicMap = null) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s === 'none') return null;
  if (dynamicMap && dynamicMap[s]) return dynamicMap[s];
  if (PLACEHOLDER_MODEL_MAP[s]) return PLACEHOLDER_MODEL_MAP[s];
  if (Object.prototype.hasOwnProperty.call(MODEL_DISPLAY_NAMES, s)) return s;

  // Match strictly against known model generations; unknown or older generations return null
  // so they are never mis-billed at another generation's retail rate.
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*)?4[-_\s]*carbon(?:$|[^a-z0-9])/.test(s)) return 'gemini-4-carbon';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*)?4[-_\s]*argon(?:$|[^a-z0-9])/.test(s)) return 'gemini-4-argon';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*)?3[._-]5[-_\s]*flash[-_\s]*lite(?:$|[^a-z0-9])/.test(s)) return 'gemini-3.5-flash-lite';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*)?3[._-]8[-_\s]*flash(?:$|[^a-z0-9])/.test(s) && !/flash[-_\s]*lite/.test(s)) return 'gemini-3.8-flash';
  if (/\bclaude\b/.test(s) && /(?:opus[-_\s]*5[._-]5|5[._-]5[-_\s]*opus)(?:$|[^0-9])/.test(s)) return 'claude-opus-5-5';
  if (/\bclaude\b/.test(s) && /(?:sonnet[-_\s]*5[._-]5|5[._-]5[-_\s]*sonnet)(?:$|[^0-9])/.test(s)) return 'claude-sonnet-5-5';
  if (/(?:^|[\s/_-])gpt[-_\s]*oss[-_\s]*120b(?:$|[^a-z0-9])/.test(s)) return 'gpt-oss-120b';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*3[._-]1|3\.1)[-_\s]*pro(?:$|[^a-z0-9])/.test(s)) return 'gemini-3.1-pro-preview';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*2[._-]5|2\.5)[-_\s]*pro(?:$|[^a-z0-9])/.test(s)) return 'gemini-2.5-pro';
  return null;
}

export function formatModelDisplayName(rawModel, modelKey = null) {
  const key = modelKey || normalizeModelId(rawModel);
  if (rawModel && !/^MODEL_PLACEHOLDER_/i.test(rawModel) && !/^MODEL_/i.test(rawModel)) {
    const clean = String(rawModel).trim();
    if (/^[a-z0-9._-]+$/i.test(clean) && key && MODEL_DISPLAY_NAMES[key]) {
      return MODEL_DISPLAY_NAMES[key];
    }
    return clean;
  }
  if (key && MODEL_DISPLAY_NAMES[key]) return MODEL_DISPLAY_NAMES[key];
  return rawModel || '未记录模型';
}

export function formatResetTimeZh(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return String(isoStr);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${m} 月 ${day} 日 ${h}:${min}`;
  } catch {
    return String(isoStr);
  }
}

function getSummaryGroupKey(g, fallbackIdx = 0) {
  if (!g || typeof g !== 'object') return `group-${fallbackIdx}`;
  const explicitId = String(g.groupId || g.id || g.poolId || g.quotaPoolId || '').trim().toLowerCase();
  if (explicitId) return explicitId;
  const modelKey = Array.isArray(g.models || g.modelIds)
    ? (g.models || g.modelIds)
        .map((m) => String(m || '').trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join('+')
    : '';
  const bucketKey = Array.isArray(g.buckets)
    ? g.buckets
        .map((b) => String(b?.bucketId || '').trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join('+')
    : '';
  const disp = String(g.displayName || g.description || '').trim().toLowerCase();
  const parts = [disp, modelKey, bucketKey].filter(Boolean);
  if (parts.length) return parts.join('|');
  return `group-${fallbackIdx}`;
}

function extractSubfamilyTags(str) {
  const s = String(str || '').toLowerCase();
  const tags = [];
  if (/\bcarbon\b/.test(s)) tags.push('carbon');
  if (/\bargon\b/.test(s)) tags.push('argon');
  if (/flash[-_\s]?lite/.test(s)) tags.push('flash-lite');
  else if (/\bflash\b/.test(s)) tags.push('flash');
  if (/\bopus\b/.test(s)) tags.push('opus');
  if (/\bsonnet\b/.test(s)) tags.push('sonnet');
  if (/\bhaiku\b/.test(s)) tags.push('haiku');
  if (/gpt[-_\s]?oss/.test(s)) tags.push('gpt-oss');
  if (/3\.1[-_\s]?pro/.test(s)) tags.push('3.1-pro');
  if (/2\.5[-_\s]?pro/.test(s)) tags.push('2.5-pro');
  return tags;
}

function resolveConfigSummaryGroup(cfg, quotaSummaryGroups = []) {
  if (!cfg || !Array.isArray(quotaSummaryGroups) || !quotaSummaryGroups.length) return null;
  const label = String(cfg.label || '').trim();
  const modelId = String(cfg.modelOrAlias?.model || cfg.modelId || '').trim();
  const strippedLabel = label.replace(/\s*\((Low|Medium|High|Thinking|Fast)\)\s*$/i, '').trim();
  const normKey = normalizeModelId(label) || normalizeModelId(modelId);
  const familyDisplay = (normKey && MODEL_DISPLAY_NAMES[normKey]) || strippedLabel || modelId || '';
  const qi = cfg.quotaInfo || {};
  const explicitPoolId = String(qi.poolId || qi.quotaPoolId || qi.groupId || cfg.quotaPoolId || '').trim().toLowerCase();

  const exactModelTokens = new Set(
    [modelId, label, strippedLabel, normKey, familyDisplay]
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const s = `${label} ${familyDisplay} ${normKey || ''} ${modelId}`.toLowerCase();
  const cfgSubfamilies = extractSubfamilyTags(s);
  const isGemini = /\b(?:gemini|carbon|argon|flash)\b/.test(s);
  const isClaude = /\b(?:claude|opus|sonnet|haiku|anthropic)\b/.test(s);
  const isGpt = /\b(?:gpt|openai|o1|o3|o4)\b/.test(s);

  const scored = [];
  for (let i = 0; i < quotaSummaryGroups.length; i++) {
    const g = quotaSummaryGroups[i];
    if (!g || typeof g !== 'object') continue;
    const gPoolIds = [g.groupId, g.id, g.poolId, g.quotaPoolId]
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean);
    const explicitModels = Array.isArray(g.models || g.modelIds)
      ? (g.models || g.modelIds).map((m) => String(m || '').trim().toLowerCase()).filter(Boolean)
      : [];
    const bucketText = Array.isArray(g.buckets)
      ? g.buckets.map((b) => String(b?.bucketId || '')).join(' ')
      : '';
    const gText = `${g.displayName || ''} ${g.description || ''} ${bucketText}`.toLowerCase();
    const gSubfamilies = extractSubfamilyTags(gText);

    let score = 0;
    if (explicitPoolId && gPoolIds.length) {
      if (gPoolIds.includes(explicitPoolId)) {
        score = 120;
      }
    } else if (explicitModels.length) {
      if (explicitModels.some((m) => exactModelTokens.has(m))) {
        score = 110;
      }
    } else if (gSubfamilies.length) {
      if (cfgSubfamilies.length && cfgSubfamilies.some((t) => gSubfamilies.includes(t))) {
        score = 90;
      }
    } else if (isGemini && /\bgemini\b/.test(gText)) {
      score = 70;
    } else if (isClaude && /\b(?:claude|anthropic)\b/.test(gText)) {
      score = 70;
    } else if (isGpt && /\b(?:gpt|openai)\b/.test(gText)) {
      score = 70;
    } else if ((isClaude || isGpt) && /\b(?:3p|third[-_\s]?party|partner)\b/.test(gText)) {
      score = 50;
    }

    if (score > 0) {
      scored.push({ g, score });
    }
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  // Reject ambiguous ties so multiple candidate groups never pick arbitrarily by sort order
  if (scored.length >= 2 && scored[0].score === scored[1].score) {
    return null;
  }
  return scored[0].g;
}

function extractSummaryBuckets(summaryGroup) {
  if (!summaryGroup || !Array.isArray(summaryGroup.buckets)) return { fiveHour: null, weekly: null };
  const b5h = summaryGroup.buckets.find((b) => b && (b.window === '5h' || /5h/i.test(b.bucketId || '')));
  const bWk = summaryGroup.buckets.find((b) => b && (b.window === 'weekly' || /week/i.test(b.bucketId || '')));
  const toWin = (b) => {
    if (!b) return null;
    const hasFrac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction);
    const resetTime = b.resetTime || null;
    if (!hasFrac && !resetTime) return null;
    return {
      remainingFraction: hasFrac ? b.remainingFraction : null,
      remainingPercent: hasFrac ? Number((b.remainingFraction * 100).toFixed(1)) : null,
      resetTime,
      resetTimeZh: formatResetTimeZh(resetTime)
    };
  };
  return { fiveHour: toWin(b5h), weekly: toWin(bWk) };
}

function buildQuotaPools(clientModelConfigs = [], quotaSummaryGroups = []) {
  if (!Array.isArray(clientModelConfigs) || !clientModelConfigs.length) {
    return { pools: [], cfgToPool: new Map() };
  }
  const rawPools = new Map();
  const cfgToPoolSig = new Map();

  for (let idx = 0; idx < clientModelConfigs.length; idx++) {
    const cfg = clientModelConfigs[idx];
    const label = cfg.label || '';
    const modelId = cfg.modelOrAlias?.model || cfg.modelId || '';
    const strippedLabel = label.replace(/\s*\((Low|Medium|High|Thinking|Fast)\)\s*$/i, '').trim();
    const normKey = normalizeModelId(label) || normalizeModelId(modelId);
    const familyKey = normKey || strippedLabel.toLowerCase() || modelId.toLowerCase() || 'unknown';
    const familyDisplay = (normKey && MODEL_DISPLAY_NAMES[normKey]) || strippedLabel || modelId || '未知模型';
    const qi = cfg.quotaInfo || {};
    const rem = typeof qi.remainingFraction === 'number' ? qi.remainingFraction : null;
    const resetTime = qi.resetTime || null;
    const explicitPoolId = String(qi.poolId || qi.quotaPoolId || qi.groupId || cfg.quotaPoolId || '').trim().toLowerCase();
    const matchedGroup = resolveConfigSummaryGroup(cfg, quotaSummaryGroups);

    // Group strictly by explicit pool ID or unambiguous summary group identity first; when absent,
    // isolate by model family so unrelated groups never merge just because remainingFraction matches.
    let poolSig;
    if (explicitPoolId) {
      poolSig = `pool:${explicitPoolId}`;
    } else if (matchedGroup) {
      poolSig = `summary:${getSummaryGroupKey(matchedGroup)}`;
    } else {
      poolSig = `family:${familyKey}|${resetTime || 'none'}|${rem !== null ? rem.toFixed(4) : 'na'}`;
    }
    cfgToPoolSig.set(idx, poolSig);

    if (!rawPools.has(poolSig)) {
      rawPools.set(poolSig, {
        id: poolSig,
        families: new Set(),
        models: [],
        summaryGroup: matchedGroup || null,
        summaryConflict: false,
        remainingFraction: rem,
        remainingPercent: rem !== null ? Number((rem * 100).toFixed(1)) : null,
        resetTime,
        resetTimeZh: formatResetTimeZh(resetTime)
      });
    }
    const entry = rawPools.get(poolSig);
    if (matchedGroup && !entry.summaryConflict) {
      if (!entry.summaryGroup) {
        entry.summaryGroup = matchedGroup;
      } else if (getSummaryGroupKey(entry.summaryGroup) !== getSummaryGroupKey(matchedGroup)) {
        entry.summaryGroup = null;
        entry.summaryConflict = true;
      }
    }
    entry.families.add(familyDisplay);
    entry.models.push({ label, modelId, familyKey: normKey || familyKey });
  }

  const resolvedBySig = new Map();
  const pools = [...rawPools.values()].map((p) => {
    const fams = [...p.families];
    const poolTitle = fams.length <= 3 ? fams.join(' / ') : `${fams.slice(0, 2).join(' / ')} 等 ${fams.length} 组`;
    const { fiveHour, weekly } = extractSummaryBuckets(p.summaryGroup);
    const has5hFrac = typeof fiveHour?.remainingFraction === 'number';
    const poolObj = {
      id: p.id,
      title: `${poolTitle} 配额池`,
      families: fams,
      modelsCount: p.models.length,
      baseRemainingFraction: p.remainingFraction,
      baseRemainingPercent: p.remainingPercent,
      baseResetTime: p.resetTime,
      baseResetTimeZh: p.resetTimeZh,
      remainingFraction: has5hFrac ? fiveHour.remainingFraction : p.remainingFraction,
      remainingPercent: has5hFrac ? fiveHour.remainingPercent : p.remainingPercent,
      resetTime: (fiveHour?.resetTime) || p.resetTime,
      resetTimeZh: (fiveHour?.resetTimeZh) || p.resetTimeZh,
      fiveHour,
      weekly,
      models: p.models
    };
    resolvedBySig.set(p.id, poolObj);
    return poolObj;
  });

  const cfgToPool = new Map();
  for (const [idx, sig] of cfgToPoolSig.entries()) {
    const poolObj = resolvedBySig.get(sig);
    if (poolObj) cfgToPool.set(idx, poolObj);
  }
  return { pools, cfgToPool };
}

export function groupModelQuotas(clientModelConfigs = [], quotaSummaryGroups = []) {
  return buildQuotaPools(clientModelConfigs, quotaSummaryGroups).pools;
}

export function resolveModelQuota(modelNameOrKey, clientModelConfigs = [], quotaSummaryGroups = []) {
  if (!Array.isArray(clientModelConfigs) || !clientModelConfigs.length || !modelNameOrKey) return null;
  const targetLower = String(modelNameOrKey).trim().toLowerCase();
  const targetNorm = normalizeModelId(modelNameOrKey);
  let matchedIdx = clientModelConfigs.findIndex((c) => {
    const lbl = String(c.label || '').toLowerCase();
    const mid = String(c.modelOrAlias?.model || c.modelId || '').toLowerCase();
    return lbl === targetLower || mid === targetLower;
  });
  if (matchedIdx < 0 && targetNorm) {
    matchedIdx = clientModelConfigs.findIndex((c) => {
      const k = normalizeModelId(c.label || '') || normalizeModelId(c.modelOrAlias?.model || c.modelId || '');
      return k === targetNorm;
    });
  }
  if (matchedIdx < 0) {
    const strippedTarget = targetLower.replace(/\s*\((low|medium|high|thinking|fast)\)\s*$/i, '').trim();
    if (strippedTarget) {
      matchedIdx = clientModelConfigs.findIndex((c) => {
        const strippedLbl = String(c.label || '').replace(/\s*\((low|medium|high|thinking|fast)\)\s*$/i, '').trim().toLowerCase();
        return strippedLbl && strippedLbl === strippedTarget;
      });
    }
  }
  if (matchedIdx < 0) return null;

  const matched = clientModelConfigs[matchedIdx];
  const displayLabel = matched.label || formatModelDisplayName(modelNameOrKey, targetNorm);
  const { cfgToPool } = buildQuotaPools(clientModelConfigs, quotaSummaryGroups);
  const pool = cfgToPool.get(matchedIdx);
  if (!pool) return null;

  return {
    label: displayLabel,
    modelKey: targetNorm,
    poolId: pool.id,
    baseRemainingFraction: pool.baseRemainingFraction,
    baseRemainingPercent: pool.baseRemainingPercent,
    baseResetTime: pool.baseResetTime,
    baseResetTimeZh: pool.baseResetTimeZh,
    remainingFraction: pool.remainingFraction,
    remainingPercent: pool.remainingPercent,
    resetTime: pool.resetTime,
    resetTimeZh: pool.resetTimeZh,
    fiveHour: pool.fiveHour,
    weekly: pool.weekly
  };
}

export function classifyRequestError(rawInput, options = {}) {
  const error = typeof rawInput === 'string' ? rawInput : String(rawInput?.error || rawInput?.message || '');
  const currentModel = options.currentModel || '';
  const modelQuota = resolveModelQuota(currentModel, options.clientModelConfigs || [], options.quotaSummaryGroups || []);

  if (!error) {
    return {
      kind: 'none',
      title: '正常',
      badgeText: '正常',
      detail: '',
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      diagnostic: ''
    };
  }

  let diagnostic = error.replace(/https?:\/\/[^\s"']+/g, '<API>').trim();
  if (diagnostic.length > 140) diagnostic = diagnostic.slice(0, 137) + '...';

  const isDeadlineTimeout = /context deadline exceeded|deadline exceeded|stream idle timeout/i.test(error);
  const overflowMatch = !isDeadlineTimeout && error.match(/input token count exceeds|context\s*(?:window|length|tokens?|limit|size|capacity)?.{0,35}(?:exceed|too long)|maximum context length|prompt exceeds maximum context length|max_tokens exceeded/i);
  if (overflowMatch) {
    const rawLim = error.match(/(?:allowed|limit(?:\s+of)?|length(?:\s+is|\s+of)?)\s*[:=]?\s*([\d,]+)/i)?.[1]?.replaceAll(',', '');
    const serviceLimit = rawLim && Number.isFinite(Number(rawLim)) ? Number(rawLim) : null;
    return {
      kind: 'context_overflow',
      title: '超限告警',
      badgeText: '超限',
      detail: `输入超出模型容量上限${serviceLimit ? `（${serviceLimit.toLocaleString()} tokens）` : ''}，建议运行 /compact 压缩上下文或新建会话。`,
      serviceLimit,
      retryAfterSec: null,
      resetTime: null,
      diagnostic
    };
  }

  const explicitQuota = /(?:quota\s*(?:exceeded|reached|limit|exhausted)|out\s+of\s+quota|exhausted.*(?:capacity|quota)|resource_exhausted.*(?:quota|capacity|billing)|free\s+tier\s+quota|daily\s+quota|weekly\s+quota)/i.test(error);
  const quotaZero = Boolean(
    modelQuota && (
      (typeof modelQuota.remainingFraction === 'number' && modelQuota.remainingFraction <= 0.0001) ||
      (typeof modelQuota.weekly?.remainingFraction === 'number' && modelQuota.weekly.remainingFraction <= 0.0001)
    )
  );
  if (explicitQuota || quotaZero) {
    return {
      kind: 'quota_exhausted',
      title: '额度耗尽',
      badgeText: '额度耗尽',
      detail: `${modelQuota?.label || currentModel || '当前模型'} 配额池已用尽${modelQuota?.resetTimeZh ? `，预计 ${modelQuota.resetTimeZh} 重置` : ''}，可切换其他配额池模型继续。`,
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: modelQuota?.resetTime || null,
      diagnostic
    };
  }

  if (/(?:rate\s*limit|too\s*many\s*requests|\b429\b|RateLimitError|RESOURCE_EXHAUSTED.*rate)/i.test(error)) {
    const retryMatch = error.match(/(?:retry\s+in|retry-after|wait)\s*[:=]?\s*([\d.]+)\s*(?:s|sec|seconds)?/i);
    const retryAfterSec = retryMatch ? parseFloat(retryMatch[1]) : null;
    return {
      kind: 'rate_limited',
      title: '请求限流',
      badgeText: '限流',
      detail: `请求触发服务端频率限制（429）${retryAfterSec ? `，建议等待 ${retryAfterSec} 秒后重试` : '，请稍候重试'}。`,
      serviceLimit: null,
      retryAfterSec,
      resetTime: null,
      diagnostic
    };
  }

  if (/(?:context canceled by user|user cancelled|request was aborted|AbortError)/i.test(error)) {
    return {
      kind: 'canceled',
      title: '已取消',
      badgeText: '已取消',
      detail: '本次生成请求已由用户或系统主动取消。',
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      diagnostic
    };
  }

  if (/(?:UNAUTHENTICATED|PERMISSION_DENIED|\b401\b|\b403\b|invalid api key|credentials expired|permission denied)/i.test(error)) {
    return {
      kind: 'auth_error',
      title: '认证异常',
      badgeText: '认证',
      detail: '身份认证失效或缺少访问权限，请检查账号登录状态。',
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      diagnostic
    };
  }

  if (/(?:UNAVAILABLE|\b503\b|\b502\b|\b504\b|server overloaded|high demand|Bad Gateway|Service Unavailable)/i.test(error)) {
    return {
      kind: 'service_unavailable',
      title: '服务繁忙',
      badgeText: '服务异常',
      detail: '模型服务暂时过载或不可用，请稍后重试。',
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      diagnostic
    };
  }

  if (/(?:\bEOF\b|idle timeout|deadline exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|Failed to fetch|NetworkError)/i.test(error)) {
    let reason = '连接失败或超时';
    if (/deadline exceeded|timeout/i.test(error)) reason = '连接或流读取超时';
    else if (/ECONNRESET|socket hang up/i.test(error)) reason = '连接被对端重置';
    else if (/ECONNREFUSED/i.test(error)) reason = '本地或代理连接被拒绝';
    else if (/ENOTFOUND/i.test(error)) reason = 'DNS 域名解析失败';
    else if (/\bEOF\b/i.test(error)) reason = '服务端提前关闭连接（EOF）';
    return {
      kind: 'network_error',
      title: '网络异常',
      badgeText: '网络',
      detail: `网络连接异常（${reason}），请检查网络或代理状态。`,
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      diagnostic
    };
  }

  return {
    kind: 'unknown',
    title: '请求异常',
    badgeText: '待确认',
    detail: `请求异常（${diagnostic}）。`,
    serviceLimit: null,
    retryAfterSec: null,
    resetTime: null,
    diagnostic
  };
}

// Heuristic text & image token measurement
export const emptyMeasure = () => ({ chars: 0, bytes: 0, low: 0, high: 0 });

export function addMeasure(target, delta) {
  if (!delta) return target;
  target.chars += delta.chars || 0;
  target.bytes += delta.bytes || 0;
  target.low += delta.low || 0;
  target.high += delta.high || 0;
  return target;
}

export function measureText(raw) {
  const text = String(raw || '');
  if (!text) return emptyMeasure();
  let chars = 0;
  let bytes = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    chars++;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) {
      cjk++;
    }
  }
  const mid = (chars - cjk) / 4 + cjk * 1.2;
  return {
    chars,
    bytes,
    low: Math.ceil(mid * 0.7),
    high: Math.ceil(Math.max(mid * 1.55, bytes / 2.2))
  };
}

export function getImageDimensions(buf) {
  try {
    if (!buf || buf.length < 12) return { width: null, height: null };
    // PNG
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // BMP
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    // WebP (RIFF....WEBP)
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8 ' && buf.length >= 30) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L' && buf.length >= 25) {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X' && buf.length >= 30) {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width: w, height: h };
      }
    }
    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset < buf.length - 9) {
        if (buf[offset] !== 0xff) { offset++; continue; }
        const marker = buf[offset + 1];
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        if (marker === 0xd9 || marker === 0xda) break;
        const segLen = buf.readUInt16BE(offset + 2);
        if (segLen < 2) break;
        offset += 2 + segLen;
      }
    }
  } catch {}
  return { width: null, height: null };
}

export function calcImageTokens(w, h) {
  if (!w || !h) return [258, 1120];
  if (w <= 384 && h <= 384) return [258, 258];
  const tiles = Math.ceil(w / 768) * Math.ceil(h / 768);
  const tok = tiles * 258;
  return [tok, Math.max(tok, 1032)];
}

// API Cost Calculation
export function matchPricingRule(modelKey, reqDateStr = PRICING_VERIFIED_DATE, totalPromptTokens = 0) {
  const rules = MODEL_PRICING_TABLE[modelKey];
  if (!rules || !rules.length) return null;
  const d = reqDateStr ? String(reqDateStr).slice(0, 10) : PRICING_VERIFIED_DATE;
  for (const r of rules) {
    if (r.effectiveTo && d > r.effectiveTo) continue;
    if (r.effectiveFrom && d < r.effectiveFrom) continue;
    if (r.maxPromptTokens && totalPromptTokens > r.maxPromptTokens) continue;
    if (r.minPromptTokens && totalPromptTokens < r.minPromptTokens) continue;
    return r;
  }
  return rules[0];
}

export function calculateRequestApiCost(req, dynamicModelMap = null) {
  if (!req) return { costUSD: null, isPriced: false, reason: '缺失请求数据' };
  const rawModel = req.modelDisplayName || req.responseModel || req.model || req.modelId || '';
  const modelKey = req.modelKey || normalizeModelId(rawModel, dynamicModelMap);
  if (!modelKey || !MODEL_PRICING_TABLE[modelKey]) {
    return {
      costUSD: null,
      isPriced: false,
      modelKey: modelKey || null,
      rawModel,
      reason: !rawModel ? '未记录模型名称' : '暂无公开零售费率'
    };
  }
  const input = Number(req.inputTokens ?? req.input_tokens ?? req.input ?? 0);
  const cache = Number(req.cacheTokens ?? req.cacheReadTokens ?? req.cache_read_tokens ?? req.cached ?? 0);
  const output = Number(req.outputTokens ?? req.output_tokens ?? req.output ?? 0);
  const thinking = Number(req.thinkingTokens ?? req.thinking_output_tokens ?? req.thinking ?? 0);
  const reqDate = req.date || req.created_at || PRICING_VERIFIED_DATE;
  const tier = matchPricingRule(modelKey, reqDate, input + cache);
  const inputCost = (input * tier.inputPerMillion) / 1_000_000;
  const cacheCost = (cache * tier.cacheReadPerMillion) / 1_000_000;
  const outputCost = (output * tier.outputPerMillion) / 1_000_000;
  const totalCost = inputCost + cacheCost + outputCost;

  return {
    costUSD: Number(totalCost.toFixed(6)),
    inputCostUSD: Number(inputCost.toFixed(6)),
    cacheCostUSD: Number(cacheCost.toFixed(6)),
    outputCostUSD: Number(outputCost.toFixed(6)),
    isPriced: true,
    modelKey,
    modelDisplayName: MODEL_DISPLAY_NAMES[modelKey] || rawModel || modelKey,
    matchedTier: tier,
    inputTokens: input,
    cacheTokens: cache,
    outputTokens: output,
    thinkingTokens: thinking,
    totalTokens: input + cache + output
  };
}

export function summarizeApiCost(requests = [], dynamicModelMap = null) {
  let pricedCostUSD = 0;
  let pricedInputCostUSD = 0;
  let pricedCacheCostUSD = 0;
  let pricedOutputCostUSD = 0;
  let pricedTokens = 0;
  let pricedInputTokens = 0;
  let pricedCacheTokens = 0;
  let pricedOutputTokens = 0;
  let pricedThinkingTokens = 0;
  let unpricedTokens = 0;
  let unpricedInputTokens = 0;
  let unpricedCacheTokens = 0;
  let unpricedOutputTokens = 0;
  let pricedRequestsCount = 0;
  let unpricedRequestsCount = 0;
  const unpricedReasons = { missingModel: 0, unsupportedModel: 0, missingUsage: 0 };
  const byModel = {};

  for (const req of requests) {
    const inp = Number(req.inputTokens ?? req.input_tokens ?? req.input ?? 0);
    const cap = Number(req.cacheTokens ?? req.cacheReadTokens ?? req.cache_read_tokens ?? req.cached ?? 0);
    const outp = Number(req.outputTokens ?? req.output_tokens ?? req.output ?? 0);
    const tot = inp + cap + outp;
    if (tot <= 0) continue;

    const calc = calculateRequestApiCost(req, dynamicModelMap);
    if (calc.isPriced) {
      pricedCostUSD += calc.costUSD;
      pricedInputCostUSD += calc.inputCostUSD;
      pricedCacheCostUSD += calc.cacheCostUSD;
      pricedOutputCostUSD += calc.outputCostUSD;
      pricedTokens += calc.totalTokens;
      pricedInputTokens += calc.inputTokens;
      pricedCacheTokens += calc.cacheTokens;
      pricedOutputTokens += calc.outputTokens;
      pricedThinkingTokens += calc.thinkingTokens;
      pricedRequestsCount++;
      if (!byModel[calc.modelKey]) {
        byModel[calc.modelKey] = {
          modelKey: calc.modelKey,
          displayName: MODEL_DISPLAY_NAMES[calc.modelKey] || calc.modelKey,
          requests: 0,
          tokens: 0,
          inputTokens: 0,
          cacheTokens: 0,
          outputTokens: 0,
          costUSD: 0
        };
      }
      const m = byModel[calc.modelKey];
      m.requests++;
      m.tokens += calc.totalTokens;
      m.inputTokens += calc.inputTokens;
      m.cacheTokens += calc.cacheTokens;
      m.outputTokens += calc.outputTokens;
      m.costUSD = Number((m.costUSD + calc.costUSD).toFixed(6));
    } else {
      unpricedRequestsCount++;
      unpricedTokens += tot;
      unpricedInputTokens += inp;
      unpricedCacheTokens += cap;
      unpricedOutputTokens += outp;
      if (!calc.rawModel) unpricedReasons.missingModel++;
      else unpricedReasons.unsupportedModel++;
      const cleanRawDisp = calc.rawModel ? formatModelDisplayName(calc.rawModel, calc.modelKey) : '';
      const unknownKey = calc.modelKey
        || (cleanRawDisp ? `unpriced:${cleanRawDisp.toLowerCase()}` : 'unidentified');
      if (!byModel[unknownKey]) {
        byModel[unknownKey] = {
          modelKey: unknownKey,
          displayName: calc.modelKey
            ? (MODEL_DISPLAY_NAMES[calc.modelKey] || calc.modelKey)
            : (cleanRawDisp || '未记录模型归档请求'),
          requests: 0,
          tokens: 0,
          inputTokens: 0,
          cacheTokens: 0,
          outputTokens: 0,
          costUSD: 0,
          unpriced: true,
          missingModel: !calc.rawModel
        };
      }
      const m = byModel[unknownKey];
      m.requests++;
      m.tokens += tot;
      m.inputTokens += inp;
      m.cacheTokens += cap;
      m.outputTokens += outp;
    }
  }

  const totalReqs = pricedRequestsCount + unpricedRequestsCount;
  const totalTok = pricedTokens + unpricedTokens;
  const tokenCoveragePercent = totalTok > 0 ? Number(((pricedTokens / totalTok) * 100).toFixed(1)) : 100;
  const requestCoveragePercent = totalReqs > 0 ? Number(((pricedRequestsCount / totalReqs) * 100).toFixed(1)) : 100;

  return {
    pricedCostUSD: Number(pricedCostUSD.toFixed(4)),
    pricedInputCostUSD: Number(pricedInputCostUSD.toFixed(4)),
    pricedCacheCostUSD: Number(pricedCacheCostUSD.toFixed(4)),
    pricedOutputCostUSD: Number(pricedOutputCostUSD.toFixed(4)),
    pricedRequestsCount,
    unpricedRequestsCount,
    totalRequestsCount: totalReqs,
    pricedTokens,
    unpricedTokens,
    byCategory: {
      inputTokens: pricedInputTokens,
      cacheTokens: pricedCacheTokens,
      outputTokens: pricedOutputTokens,
      thinkingTokens: pricedThinkingTokens
    },
    unpricedByCategory: {
      inputTokens: unpricedInputTokens,
      cacheTokens: unpricedCacheTokens,
      outputTokens: unpricedOutputTokens
    },
    tokenCoveragePercent,
    requestCoveragePercent,
    unpricedReasons,
    byModel: Object.values(byModel).sort((a, b) => (b.costUSD - a.costUSD) || (b.tokens - a.tokens))
  };
}

export function calculateReferenceCost(tokenTotals = {}, refModelKey = 'gemini-3.8-flash', pricingDate = PRICING_VERIFIED_DATE) {
  const input = Number(tokenTotals.inputTokens ?? tokenTotals.input ?? 0);
  const cache = Number(tokenTotals.cacheTokens ?? tokenTotals.cache ?? 0);
  const output = Number(tokenTotals.outputTokens ?? tokenTotals.output ?? 0);
  const total = Number(tokenTotals.totalTokens ?? tokenTotals.total ?? (input + cache + output));
  const normKey = normalizeModelId(refModelKey) || 'gemini-3.8-flash';
  const tier = matchPricingRule(normKey, pricingDate, 0) || MODEL_PRICING_TABLE['gemini-3.8-flash'][0];

  const inputCost = (input * tier.inputPerMillion) / 1_000_000;
  const cacheCost = (cache * tier.cacheReadPerMillion) / 1_000_000;
  const outputCost = (output * tier.outputPerMillion) / 1_000_000;
  const totalCost = inputCost + cacheCost + outputCost;

  return {
    modelKey: normKey,
    modelDisplayName: MODEL_DISPLAY_NAMES[normKey] || normKey,
    tier,
    inputTokens: input,
    cacheTokens: cache,
    outputTokens: output,
    totalTokens: total,
    inputCostUSD: Number(inputCost.toFixed(4)),
    cacheCostUSD: Number(cacheCost.toFixed(4)),
    outputCostUSD: Number(outputCost.toFixed(4)),
    totalCostUSD: Number(totalCost.toFixed(4))
  };
}

// Subscription & Currency Presets
export const CURRENCY_SYMBOLS = {
  USD: '$', CNY: '¥', JPY: '¥', HKD: 'HK$', EUR: '€', GBP: '£', SGD: 'S$',
  TRY: '₺', NGN: '₦', TWD: 'NT$', PHP: '₱', INR: '₹', BRL: 'R$', CAD: 'CA$',
  AUD: 'AU$', MYR: 'RM ', KRW: '₩', NZD: 'NZ$', THB: '฿', VND: '₫', IDR: 'Rp ',
  PKR: '₨ ', MXN: '$', ARS: '$', CLP: '$', COP: '$', PEN: 'S/ ', CHF: 'CHF ',
  UAH: '₴', PLN: 'zł ', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ', CZK: 'Kč ',
  HUF: 'Ft ', RON: 'lei ', ZAR: 'R ', EGP: 'E£ ', KES: 'KSh ', AED: 'AED ',
  SAR: 'SAR ', ILS: '₪ '
};

export const SUBSCRIPTION_ACQUISITION_PRESETS = [
  { id: 'normal_paid', name: '个人常规付费订阅', category: 'paid', defaultPaid: null, note: '按月或按年个人官方标准价订阅' },
  { id: 'family_sharing', name: '家庭组共享 / 他人赠送（免额外付费）', category: 'sharing', defaultPaid: 0, note: '加入 Google One 家庭组共享 Ultra / Pro 额度（个人 $0 实付）' },
  { id: 'family_split', name: '家庭组拼车 / AA 分摊', category: 'sharing_paid', defaultPaid: null, note: '加入 Google One 家庭组共享额度，按个人实际分摊金额折算' },
  { id: 'student_offer', name: '学生认证优惠', category: 'discount', defaultPaid: 0, note: 'Google One AI 学生专享试用或优惠' },
  { id: 'pixel_bundle', name: 'Google Pixel 设备赠送', category: 'bundle_free', defaultPaid: 0, note: '购机附赠 Google AI Pro 权益' },
  { id: 'chromebook_bundle', name: 'Chromebook Plus 赠送', category: 'bundle_free', defaultPaid: 0, note: '符合资格的 Chromebook Plus 附赠权益' },
  { id: 'samsung_galaxy', name: 'Samsung Galaxy 活动权益', category: 'bundle_free', defaultPaid: 0, note: '指定机型附赠 Google AI 权益' },
  { id: 'jio_offer', name: 'Jio 运营商套餐权益', category: 'partner', defaultPaid: 0, note: '运营商合作绑定 AI 权益' },
  { id: 'partner_carrier', name: '其他运营商 / 合作方权益', category: 'partner', defaultPaid: 0, note: '宽带、通信套餐或第三方平台附赠权益' },
  { id: 'official_promo', name: '官方限时试用 / 首季优惠', category: 'promo', defaultPaid: null, note: '首月免费、Ultra 首季半价（$124.99）等官方促销' },
  { id: 'custom_source', name: '其他自定义来源', category: 'custom', defaultPaid: null, note: '自定义渠道或企业订阅' }
];

export const SUBSCRIPTION_REGIONS_PRESET = [
  { id: 'US', name: '美国 (US)', currency: 'USD', symbol: '$', monthlyPrice: 19.99, ultraMonthlyPrice: 249.99, rateToCNY: 6.72, aliases: ['us', 'usa', '美国', '美区'] },
  { id: 'JP', name: '日本 (JP)', currency: 'JPY', symbol: '¥', monthlyPrice: 2900, ultraMonthlyPrice: 36400, rateToCNY: 0.0425, aliases: ['jp', 'japan', '日本', '日区'] },
  { id: 'KR', name: '韩国 (KR)', currency: 'KRW', symbol: '₩', monthlyPrice: 29000, ultraMonthlyPrice: 360000, rateToCNY: 0.0051, aliases: ['kr', 'korea', '韩国', '韩区'] },
  { id: 'HK', name: '中国香港 (HK)', currency: 'HKD', symbol: 'HK$', monthlyPrice: 158, ultraMonthlyPrice: 1950, rateToCNY: 0.857, aliases: ['hk', '香港', '中国香港', '港区'] },
  { id: 'TW', name: '中国台湾 (TW)', currency: 'TWD', symbol: 'NT$', monthlyPrice: 650, ultraMonthlyPrice: 8150, rateToCNY: 0.21, aliases: ['tw', '台湾', '中国台湾', '台区'] },
  { id: 'SG', name: '新加坡 (SG)', currency: 'SGD', symbol: 'S$', monthlyPrice: 27.99, ultraMonthlyPrice: 348.00, rateToCNY: 5.12, aliases: ['sg', '新加坡'] },
  { id: 'AU', name: '澳大利亚 (AU)', currency: 'AUD', symbol: 'AU$', monthlyPrice: 32.99, ultraMonthlyPrice: 409.99, rateToCNY: 4.45, aliases: ['au', '澳大利亚', '澳洲', '澳区'] },
  { id: 'GB', name: '英国 (UK)', currency: 'GBP', symbol: '£', monthlyPrice: 18.99, ultraMonthlyPrice: 234.99, rateToCNY: 8.75, aliases: ['gb', 'uk', '英国', '英区'] },
  { id: 'EU', name: '欧洲 / 欧元区 (EU)', currency: 'EUR', symbol: '€', monthlyPrice: 21.99, ultraMonthlyPrice: 274.99, rateToCNY: 7.52, aliases: ['eu', 'eur', '欧洲', '欧盟', '德国', '法国'] },
  { id: 'CA', name: '加拿大 (CA)', currency: 'CAD', symbol: 'CA$', monthlyPrice: 26.99, ultraMonthlyPrice: 339.99, rateToCNY: 4.88, aliases: ['ca', '加拿大'] },
  { id: 'TR', name: '土耳其 (TR)', currency: 'TRY', symbol: '₺', monthlyPrice: 869.99, ultraMonthlyPrice: 8999.99, rateToCNY: 0.133, aliases: ['tr', '土耳其', '土区'] },
  { id: 'NG', name: '尼日利亚 (NG)', currency: 'NGN', symbol: '₦', monthlyPrice: 28500, ultraMonthlyPrice: 355000, rateToCNY: 0.0042, aliases: ['ng', '尼日利亚', '尼区'] },
  { id: 'PH', name: '菲律宾 (PH)', currency: 'PHP', symbol: '₱', monthlyPrice: 1100, ultraMonthlyPrice: 13750, rateToCNY: 0.117, aliases: ['ph', '菲律宾'] },
  { id: 'IN', name: '印度 (IN)', currency: 'INR', symbol: '₹', monthlyPrice: 1950, ultraMonthlyPrice: 24500, rateToCNY: 0.076, aliases: ['in', '印度', '印区'] },
  { id: 'MY', name: '马来西亚 (MY)', currency: 'MYR', symbol: 'RM ', monthlyPrice: 97.99, ultraMonthlyPrice: 1199.90, rateToCNY: 1.55, aliases: ['my', '马来西亚'] },
  { id: 'BR', name: '巴西 (BR)', currency: 'BRL', symbol: 'R$', monthlyPrice: 96.99, ultraMonthlyPrice: 1209.90, rateToCNY: 1.18, aliases: ['br', '巴西'] },
  { id: 'NZ', name: '新西兰 (NZ)', currency: 'NZD', symbol: 'NZ$', monthlyPrice: 34.99, ultraMonthlyPrice: 439.99, rateToCNY: 4.05, aliases: ['nz', '新西兰'] },
  { id: 'TH', name: '泰国 (TH)', currency: 'THB', symbol: '฿', monthlyPrice: 750, ultraMonthlyPrice: 9300, rateToCNY: 0.20, aliases: ['th', '泰国'] },
  { id: 'VN', name: '越南 (VN)', currency: 'VND', symbol: '₫', monthlyPrice: 489000, ultraMonthlyPrice: 6100000, rateToCNY: 0.00028, aliases: ['vn', '越南'] },
  { id: 'ID', name: '印度尼西亚 (ID)', currency: 'IDR', symbol: 'Rp ', monthlyPrice: 309000, ultraMonthlyPrice: 3850000, rateToCNY: 0.00044, aliases: ['id', '印尼', '印度尼西亚'] },
  { id: 'CH', name: '瑞士 (CH)', currency: 'CHF', symbol: 'CHF ', monthlyPrice: 17.00, ultraMonthlyPrice: 215.00, rateToCNY: 7.85, aliases: ['ch', '瑞士'] },
  { id: 'CN', name: '中国大陆 / 人民币折算 (CNY)', currency: 'CNY', symbol: '¥', monthlyPrice: 140.00, ultraMonthlyPrice: 1680.00, rateToCNY: 1.0, aliases: ['cn', 'cny', '中国', '中国大陆', '人民币'] }
];

export function getRegionTierMonthlyPrice(regionPreset, tierKey = 'pro') {
  if (!regionPreset) return null;
  if (tierKey === 'free') return 0;
  if (tierKey === 'ultra') {
    if (typeof regionPreset.ultraMonthlyPrice === 'number') return regionPreset.ultraMonthlyPrice;
    return Number((regionPreset.monthlyPrice * (249.99 / 19.99)).toFixed(2));
  }
  if (tierKey === 'plus') {
    if (regionPreset.id === 'US') return 4.99;
    return Number((regionPreset.monthlyPrice * 0.25).toFixed(2));
  }
  return regionPreset.monthlyPrice;
}

const CURRENCY_RATE_TO_CNY = Object.fromEntries(
  SUBSCRIPTION_REGIONS_PRESET.map((r) => [r.currency, r.rateToCNY])
);
CURRENCY_RATE_TO_CNY.USD = 6.72;
CURRENCY_RATE_TO_CNY.CNY = 1.0;

export function findRegionPreset(query) {
  if (!query || typeof query !== 'string') return null;
  const q = query.trim().toLowerCase();
  return SUBSCRIPTION_REGIONS_PRESET.find((r) =>
    r.id.toLowerCase() === q ||
    r.name.toLowerCase() === q ||
    r.aliases.some((a) => a.toLowerCase() === q || q.includes(a.toLowerCase()))
  ) || null;
}

export function convertToCNY(amount, currency = 'USD', regionHint = null) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return null;
  const num = Number(amount);
  if (num === 0) return 0;
  const cur = String(currency || 'USD').toUpperCase();
  if (cur === 'CNY') return Number(num.toFixed(2));
  const preset = regionHint ? findRegionPreset(regionHint) : null;
  if (preset && preset.currency === cur) {
    return Number((num * preset.rateToCNY).toFixed(2));
  }
  const rate = CURRENCY_RATE_TO_CNY[cur] || 6.72;
  return Number((num * rate).toFixed(2));
}

export function convertToUSD(amount, currency = 'USD', regionHint = null) {
  const cny = convertToCNY(amount, currency, regionHint);
  if (cny === null) return null;
  if (cny === 0) return 0;
  return Number((cny / CURRENCY_RATE_TO_CNY.USD).toFixed(2));
}

export function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0] || '*'}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

export function parseUserPlanStatus(raw) {
  const us = raw?.userStatus || raw || {};
  const userTier = us.userTier || {};
  const planStatus = us.planStatus || {};
  const planInfo = planStatus.planInfo || {};
  const email = us.email || null;
  const rawTierName = String(userTier.name || planInfo.planName || '').trim();
  const rawPlanSub = String(planInfo.planName || '').trim();

  const hasEvidence = Boolean(
    rawTierName ||
    userTier.id ||
    planStatus.availablePromptCredits !== undefined ||
    planInfo.monthlyPromptCredits !== undefined
  );

  if (!hasEvidence) {
    return {
      status: 'unidentified',
      tierKey: 'unknown',
      tierName: '未识别套餐',
      planName: '未知',
      maskedEmail: maskEmail(email),
      hasEmail: Boolean(email),
      officialPriceMonthly: null,
      currency: 'USD',
      symbol: '$',
      priceRangeNote: '可在下方补充订阅地区或实付金额',
      promptCredits: null,
      flowCredits: null,
      updatedAt: null
    };
  }

  let tierKey = 'custom';
  let tierName = rawTierName || '已识别套餐';
  let officialPrice = null;
  let priceRangeNote = '费率按订阅方案而定';

  if (/ultra/i.test(rawTierName) || /ultra/i.test(userTier.id || '')) {
    tierKey = 'ultra';
    // Antigravity sets planInfo.planName = "Pro" (internal TEAMS_TIER_PRO engine capability)
    // on all paid Google One AI plans including Ultra; keep the real Google One tier name.
    tierName = rawTierName && /ultra/i.test(rawTierName) ? rawTierName : 'Google AI Ultra';
    officialPrice = 249.99;
    priceRangeNote = '美区公开参考价 $249.99/月（家庭组共享 / 拼车 / 促销可在右上角设置实付）';
  } else if (/pro/i.test(rawTierName) || /pro/i.test(userTier.id || '')) {
    tierKey = 'pro';
    tierName = 'Google AI Pro';
    officialPrice = 19.99;
    priceRangeNote = '$19.99/月（美区公开参考价）';
  } else if (/plus/i.test(rawTierName) || /plus/i.test(userTier.id || '')) {
    tierKey = 'plus';
    tierName = 'Google AI Plus';
    officialPrice = 4.99;
    priceRangeNote = '$4.99/月（公开参考价）';
  } else if (/free/i.test(rawTierName) || /free/i.test(userTier.id || '')) {
    tierKey = 'free';
    tierName = 'Free 免费版';
    officialPrice = 0;
    priceRangeNote = '$0/月';
  }

  return {
    status: 'identified',
    tierKey,
    tierName,
    planName: rawPlanSub || tierName,
    maskedEmail: maskEmail(email),
    hasEmail: Boolean(email),
    officialPriceMonthly: officialPrice,
    currency: 'USD',
    symbol: '$',
    priceRangeNote,
    promptCredits: {
      available: planStatus.availablePromptCredits ?? null,
      monthly: planInfo.monthlyPromptCredits ?? null
    },
    flowCredits: {
      available: planStatus.availableFlowCredits ?? null,
      monthly: planInfo.monthlyFlowCredits ?? null
    },
    updatedAt: new Date().toISOString()
  };
}

export function resolveEffectivePlanStatus(livePlan, customPlan = null) {
  const base = livePlan || parseUserPlanStatus(null);
  const custom = customPlan && typeof customPlan === 'object' ? customPlan : {};
  const isCustomized = Boolean(customPlan && Object.keys(customPlan).length > 0);

  const subscriptionRegion = custom.subscriptionRegion || custom.region || 'US';
  const regionPreset = findRegionPreset(subscriptionRegion) || SUBSCRIPTION_REGIONS_PRESET[0];
  const accountCountry = custom.accountCountry || '自动 / 未设置';
  const acquisitionId = custom.acquisitionId || 'normal_paid';
  const acqPreset = SUBSCRIPTION_ACQUISITION_PRESETS.find((a) => a.id === acquisitionId) || SUBSCRIPTION_ACQUISITION_PRESETS[0];
  const customAcqName = custom.acquisitionName ? String(custom.acquisitionName).trim() : '';
  const acquisitionLabel = isCustomized
    ? (customAcqName || acqPreset.name)
    : '未指定（默认按公开参考价折算）';

  const currency = (custom.currency && CURRENCY_SYMBOLS[custom.currency.toUpperCase()])
    ? custom.currency.toUpperCase()
    : (regionPreset?.currency || base.currency || 'USD');
  const symbol = CURRENCY_SYMBOLS[currency] || '$';
  const billingCycle = custom.billingCycle || '月付';
  const priceMode = custom.priceMode === 'custom' ? 'custom' : 'preset';
  const zeroExtra = Boolean(custom.zeroExtra);

  let effectivePrice = null;
  if (zeroExtra) {
    effectivePrice = 0;
  } else if (priceMode === 'custom' && custom.actualPricePaid !== null && custom.actualPricePaid !== undefined && custom.actualPricePaid !== '') {
    const n = Number(custom.actualPricePaid);
    effectivePrice = Number.isFinite(n) && n >= 0 ? n : null;
  } else if (base.tierKey === 'free') {
    effectivePrice = 0;
  } else if (regionPreset && currency === regionPreset.currency) {
    effectivePrice = getRegionTierMonthlyPrice(regionPreset, base.tierKey);
  } else if (base.officialPriceMonthly !== null) {
    effectivePrice = base.officialPriceMonthly;
  }

  // Monthly normalized price (if annual billing, divide by 12 for monthly comparison)
  const monthlyNormalized = effectivePrice === null
    ? null
    : billingCycle === '年付'
      ? Number((effectivePrice / 12).toFixed(2))
      : effectivePrice;

  const monthlyCNY = monthlyNormalized !== null ? convertToCNY(monthlyNormalized, currency, subscriptionRegion) : null;
  const monthlyUSD = monthlyNormalized !== null ? convertToUSD(monthlyNormalized, currency, subscriptionRegion) : null;

  return {
    ...base,
    accountCountry,
    subscriptionRegion: regionPreset ? regionPreset.id : subscriptionRegion,
    subscriptionRegionName: regionPreset ? regionPreset.name : subscriptionRegion,
    acquisitionId,
    acquisitionLabel,
    acquisitionNote: acqPreset.note,
    currency,
    symbol,
    billingCycle,
    priceMode,
    zeroExtra,
    effectivePrice,
    monthlyNormalized,
    monthlyCNY,
    monthlyUSD,
    validUntil: custom.validUntil || '',
    note: custom.note || '',
    isCustomized
  };
}
