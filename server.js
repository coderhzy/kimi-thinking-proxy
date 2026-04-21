#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const VERSION = '0.3.0';
const DEFAULT_CONFIG_PATH = process.env.CONFIG_PATH || '/app/config.json';

const DEFAULT_CONFIG = {
  port: 8919,
  host: '0.0.0.0',
  target_host: 'api.kimi.com',
  target_path_prefix: '/coding',
  coding_ua: 'claude-cli/2.1.44 (external, sdk-cli)',
  auto_thinking: true,
  thinking_budget_tokens: 512,
  rate_limit_rpm: 30,
  max_retries: 2,
  request_timeout_ms: 120000,
  disable_backoff_ms: [60000, 300000, 1800000, 3600000, 86400000],
  force_temperature: {},
  admin: {
    enabled: false,
    token: ''
  },
  retry_on_http_error: true,
  keys: [],
  models: [
    { id: 'kimi-k2.5-thinking', name: 'Kimi K2.5 Thinking' },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', thinking: false },
    { id: 'kimi-for-coding', name: 'Kimi for Coding' },
    { id: 'K2.6', name: 'K2.6' }
  ],
  probe_check: {
    enabled: false,
    path: '/coding/v1/chat/completions',
    model: 'kimi-for-coding',
    interval_ms: 600000
  },
  feishu: {
    enabled: false,
    webhook: ''
  }
};

let CONFIG = loadConfig();
let keyPool = [];
let probeCheckerTimer = null;
const stats = {
  startTime: Date.now(),
  requestsTotal: 0,
  requestsSucceeded: 0,
  requestsFailed: 0,
  retriesTotal: 0,
  imageConversions: 0,
  upstreamNetworkErrors: 0,
  upstreamHttpErrors: 0,
  parseFallbacks: 0,
  lastRequestAt: 0,
  perRoute: Object.create(null)
};

initKeyPool();
startProbeChecker();
watchConfig();

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function envNumber(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function mergeConfig(base, extra) {
  const merged = Object.assign({}, base, extra || {});
  merged.feishu = Object.assign({}, base.feishu || {}, (extra || {}).feishu || {});
  merged.probe_check = Object.assign({}, base.probe_check || {}, (extra || {}).probe_check || {});
  merged.admin = Object.assign({}, base.admin || {}, (extra || {}).admin || {});
  merged.models = mergeModels(base.models, (extra || {}).models);
  return merged;
}

function mergeModels(baseModels, extraModels) {
  const baseList = Array.isArray(baseModels) ? baseModels : [];
  if (!Array.isArray(extraModels)) return baseList.slice();
  const extraById = new Map(extraModels.filter(m => m && m.id).map(m => [m.id, m]));
  const result = baseList.map(m => (extraById.has(m.id) ? Object.assign({}, m, extraById.get(m.id)) : m));
  const baseIds = new Set(baseList.map(m => m.id));
  for (const m of extraModels) {
    if (m && m.id && !baseIds.has(m.id)) result.push(m);
  }
  return result;
}

function loadConfig() {
  try {
    let fileConfig = {};
    if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
      fileConfig = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf-8'));
    }

    let cfg = mergeConfig(DEFAULT_CONFIG, fileConfig);

    cfg.port = envNumber('PORT', cfg.port);
    cfg.host = process.env.HOST || cfg.host;
    cfg.target_host = process.env.TARGET_HOST || cfg.target_host;
    cfg.target_path_prefix = process.env.TARGET_PATH_PREFIX || cfg.target_path_prefix;
    cfg.coding_ua = process.env.CODING_UA || cfg.coding_ua;
    cfg.auto_thinking = envBool('AUTO_THINKING', cfg.auto_thinking);
    cfg.rate_limit_rpm = envNumber('RATE_LIMIT_RPM', cfg.rate_limit_rpm);
    cfg.max_retries = envNumber('MAX_RETRIES', cfg.max_retries);
    cfg.request_timeout_ms = envNumber('REQUEST_TIMEOUT_MS', cfg.request_timeout_ms);

    if (process.env.KIMI_KEYS) {
      cfg.keys = process.env.KIMI_KEYS.split(',').map((key, index) => ({
        key: key.trim(),
        name: `env-${index + 1}`
      })).filter(item => item.key);
    }

    cfg.feishu = cfg.feishu || {};
    cfg.feishu.enabled = envBool('FEISHU_ENABLED', cfg.feishu.enabled);
    cfg.feishu.webhook = process.env.FEISHU_WEBHOOK || cfg.feishu.webhook || '';

    cfg.admin = cfg.admin || {};
    cfg.admin.enabled = envBool('ADMIN_ENABLED', cfg.admin.enabled);
    cfg.admin.token = process.env.ADMIN_TOKEN || cfg.admin.token || '';

    console.log('[INFO] 配置已加载:', {
      config_path: DEFAULT_CONFIG_PATH,
      target_host: cfg.target_host,
      target_path_prefix: cfg.target_path_prefix,
      port: cfg.port,
      keys: (cfg.keys || []).length
    });

    return cfg;
  } catch (error) {
    console.log('[ERROR] 加载配置失败:', error.message);
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function watchConfig() {
  if (!fs.existsSync(DEFAULT_CONFIG_PATH)) return;
  fs.watchFile(DEFAULT_CONFIG_PATH, { interval: 10000 }, function () {
    console.log('[INFO] 配置文件变化，重新加载...');
    CONFIG = loadConfig();
    initKeyPool();
    startProbeChecker();
  });
}

function initKeyPool() {
  const oldByKey = Object.create(null);
  keyPool.forEach(function (k) { oldByKey[k.key] = k; });

  keyPool = (CONFIG.keys || []).map(function (item, index) {
    const old = oldByKey[item.key];
    const configEnabled = item.enabled !== false;
    const weight = typeof item.weight === 'number' && item.weight > 0 ? item.weight : 1;

    if (old) {
      old.index = index;
      old.name = item.name || old.name;
      old.note = item.note || '';
      old.weight = weight;
      if (!configEnabled) {
        old.enabled = false;
      } else if (old.enabled === false && !old.disabledUntil) {
        old.enabled = true;
      }
      return old;
    }

    return {
      index,
      key: item.key,
      name: item.name || `key-${index + 1}`,
      note: item.note || '',
      weight,
      enabled: configEnabled,
      requestCount: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      disableTier: 0,
      lastError: '',
      lastErrorTime: 0,
      lastUsed: 0,
      minuteRequests: [],
      disabledUntil: 0,
      probeStatus: null,
      lastProbeAt: 0
    };
  });
  console.log('[INFO] Key 池初始化:', keyPool.length, '个 key（保留 ' + Object.keys(oldByKey).filter(k => keyPool.find(p => p.key === k)).length + ' 个已有状态）');
}

function nowIso() {
  return new Date().toISOString().slice(11, 19);
}

function markRoute(url) {
  const route = (url || '').split('?')[0] || '/';
  stats.perRoute[route] = (stats.perRoute[route] || 0) + 1;
}

function sendFeishu(text) {
  if (!CONFIG.feishu || !CONFIG.feishu.enabled || !CONFIG.feishu.webhook) {
    return;
  }

  const body = JSON.stringify({
    msg_type: 'text',
    content: { text }
  });

  const url = new URL(CONFIG.feishu.webhook);
  const req = https.request({
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    timeout: 15000
  }, function (res) {
    res.resume();
  });

  req.on('error', function (error) {
    console.log('[WARN] 飞书通知失败:', error.message);
  });

  req.write(body);
  req.end();
}

function getNextKey(excludeKey) {
  if (!keyPool.length) return null;

  const now = Date.now();
  const rpm = CONFIG.rate_limit_rpm || 30;
  const cutoff = now - 60000;

  for (const item of keyPool) {
    if (item.disabledUntil && item.disabledUntil <= now) {
      item.enabled = true;
      item.disabledUntil = 0;
      item.consecutiveErrors = 0;
      console.log('[INFO] Key', item.name, '自动恢复');
    }
    item.minuteRequests = item.minuteRequests.filter(ts => ts > cutoff);
  }

  let best = null;
  let bestLoad = Infinity;
  let bestLastUsed = Infinity;

  for (const candidate of keyPool) {
    if (excludeKey && candidate === excludeKey) continue;
    if (!candidate.enabled) continue;
    if (candidate.disabledUntil && candidate.disabledUntil > now) continue;
    if (candidate.minuteRequests.length >= rpm) continue;

    const weight = candidate.weight || 1;
    const load = candidate.minuteRequests.length / weight;
    if (load < bestLoad || (load === bestLoad && candidate.lastUsed < bestLastUsed)) {
      best = candidate;
      bestLoad = load;
      bestLastUsed = candidate.lastUsed;
    }
  }

  if (!best) return null;
  best.requestCount += 1;
  best.lastUsed = now;
  best.minuteRequests.push(now);
  return best;
}

function markKeySuccess(keyObj) {
  if (!keyObj) return;
  keyObj.consecutiveErrors = 0;
  keyObj.disableTier = 0;
  keyObj.lastError = '';
}

function isQuotaError(statusCode, body) {
  if (statusCode === 402) return true;
  if (statusCode === 403 || statusCode === 429) {
    const text = (body || '').toLowerCase();
    if (text.includes('access_terminated_error')) return true;
    if (text.includes('usage limit') || text.includes('billing cycle')) return true;
    if (text.includes('quota') && (text.includes('exhaust') || text.includes('refresh') || text.includes('upgrade'))) return true;
  }
  return false;
}

function markKeyQuotaExhausted(keyObj) {
  if (!keyObj) return;
  keyObj.enabled = false;
  keyObj.disabledUntil = Date.now() + 24 * 60 * 60 * 1000;
  keyObj.lastError = 'quota exhausted';
  keyObj.lastErrorTime = Date.now();
  keyObj.errorCount += 1;
  console.log('[WARN] Key', keyObj.name, '额度耗尽，禁用 1 天');
  sendFeishu(`[Kimi Proxy] Key ${keyObj.name} 额度耗尽，已禁用 1 天`);
}

function markKeyError(keyObj, message, options) {
  if (!keyObj) return;
  const isTransient = !!(options && options.transient);
  keyObj.errorCount += 1;
  keyObj.lastError = message || 'unknown error';
  keyObj.lastErrorTime = Date.now();

  if (isTransient) {
    return;
  }

  keyObj.consecutiveErrors += 1;

  if (keyObj.consecutiveErrors < 3) return;

  const backoff = CONFIG.disable_backoff_ms || DEFAULT_CONFIG.disable_backoff_ms;
  const tier = Math.min(keyObj.disableTier, backoff.length - 1);
  const duration = backoff[tier];
  keyObj.enabled = false;
  keyObj.disabledUntil = Date.now() + duration;
  keyObj.disableTier = Math.min(keyObj.disableTier + 1, backoff.length - 1);
  keyObj.consecutiveErrors = 0;

  const humanDur = duration >= 60000
    ? `${Math.round(duration / 60000)} 分钟`
    : `${Math.round(duration / 1000)} 秒`;
  console.log('[WARN] Key', keyObj.name, `连续失败，禁用 ${humanDur} (tier ${tier})`);

  if (duration >= 3600000) {
    sendFeishu(`[Kimi Proxy] Key ${keyObj.name} 连续失败，禁用 ${humanDur}\n原因: ${keyObj.lastError}`);
  }
}

function saveConfigToDisk() {
  const snapshot = {
    port: CONFIG.port,
    host: CONFIG.host,
    target_host: CONFIG.target_host,
    target_path_prefix: CONFIG.target_path_prefix,
    coding_ua: CONFIG.coding_ua,
    auto_thinking: CONFIG.auto_thinking,
    thinking_budget_tokens: CONFIG.thinking_budget_tokens,
    rate_limit_rpm: CONFIG.rate_limit_rpm,
    max_retries: CONFIG.max_retries,
    request_timeout_ms: CONFIG.request_timeout_ms,
    disable_backoff_ms: CONFIG.disable_backoff_ms,
    force_temperature: CONFIG.force_temperature,
    retry_on_http_error: CONFIG.retry_on_http_error,
    models: CONFIG.models,
    keys: CONFIG.keys,
    probe_check: CONFIG.probe_check,
    admin: CONFIG.admin,
    feishu: CONFIG.feishu
  };
  fs.writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(snapshot, null, 2));
}

function shouldRetryStatus(statusCode, body) {
  if (!CONFIG.retry_on_http_error) return false;
  if (statusCode === 401) return true;
  if (statusCode >= 500) return true;
  if (isQuotaError(statusCode, body)) return true;
  return false;
}

function markKeyDead(keyObj, reason) {
  if (!keyObj) return;
  keyObj.enabled = false;
  keyObj.disabledUntil = Date.now() + 365 * 24 * 60 * 60 * 1000;
  keyObj.lastError = reason || 'key invalid';
  keyObj.lastErrorTime = Date.now();
  keyObj.errorCount += 1;
  console.log('[ERROR] Key', keyObj.name, '已永久禁用:', keyObj.lastError);
  sendFeishu(`[Kimi Proxy] Key ${keyObj.name} 失效，已永久禁用\n原因: ${keyObj.lastError}`);
}

function probeKey(keyObj) {
  const cfg = CONFIG.probe_check || {};
  if (!keyObj || !keyObj.key) return;

  const probeBody = {
    model: cfg.model || 'kimi-for-coding',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    temperature: 0.6,
    stream: false
  };
  if (shouldInjectThinking(probeBody.model)) {
    probeBody.thinking = {
      type: 'enabled',
      budget_tokens: CONFIG.thinking_budget_tokens || 512
    };
  }
  const body = JSON.stringify(probeBody);

  const options = {
    hostname: CONFIG.target_host,
    port: 443,
    path: cfg.path || '/coding/v1/chat/completions',
    method: 'POST',
    headers: {
      host: CONFIG.target_host,
      authorization: `Bearer ${keyObj.key}`,
      'user-agent': CONFIG.coding_ua || DEFAULT_CONFIG.coding_ua,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      accept: 'application/json'
    },
    timeout: 15000
  };

  const req = https.request(options, function (res) {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', function () {
      keyObj.lastProbeAt = Date.now();
      const fullText = Buffer.concat(chunks).toString('utf-8');
      const text = fullText.slice(0, 300);

      if (isQuotaError(res.statusCode, fullText)) {
        keyObj.probeStatus = 'quota_exhausted';
        if (keyObj.enabled) {
          console.log(`[WARN] Key ${keyObj.name} 探活 HTTP ${res.statusCode}，额度耗尽`);
          markKeyQuotaExhausted(keyObj);
        }
      } else if (res.statusCode === 401) {
        keyObj.probeStatus = 'invalid';
        if (keyObj.enabled) markKeyDead(keyObj, `HTTP 401: ${text}`);
      } else if (res.statusCode === 403) {
        keyObj.probeStatus = 'forbidden';
        if (keyObj.enabled) markKeyDead(keyObj, `HTTP 403: ${text}`);
      } else if (res.statusCode >= 200 && res.statusCode < 300) {
        keyObj.probeStatus = 'healthy';
        const cfgKey = (CONFIG.keys || [])[keyObj.index];
        const configEnabled = !cfgKey || cfgKey.enabled !== false;
        if (!keyObj.enabled && configEnabled) {
          const prevReason = keyObj.lastError || 'unknown';
          console.log(`[INFO] Key ${keyObj.name} 探活成功，从 "${prevReason}" 恢复可用`);
          keyObj.enabled = true;
          keyObj.disabledUntil = 0;
          keyObj.consecutiveErrors = 0;
          keyObj.disableTier = 0;
          keyObj.lastError = '';
        }
      } else {
        keyObj.probeStatus = `http_${res.statusCode}`;
      }
    });
  });

  req.on('error', function (error) {
    keyObj.probeStatus = 'network_error';
    keyObj.lastProbeAt = Date.now();
    console.log(`[WARN] 探活网络错误 ${keyObj.name}: ${error.message}`);
  });
  req.on('timeout', function () {
    req.destroy(new Error('probe timeout'));
  });
  req.write(body);
  req.end();
}

function startProbeChecker() {
  if (probeCheckerTimer) {
    clearInterval(probeCheckerTimer);
    probeCheckerTimer = null;
  }
  const cfg = CONFIG.probe_check || {};
  if (!cfg.enabled) {
    console.log('[INFO] 探活检测未启用');
    return;
  }
  const interval = cfg.interval_ms || 600000;
  probeCheckerTimer = setInterval(function () {
    keyPool.forEach(probeKey);
  }, interval);
  console.log(`[INFO] 探活检测已启动: model=${cfg.model || 'kimi-for-coding'}, 间隔=${Math.round(interval / 1000)}s`);
  setTimeout(function () {
    keyPool.forEach(probeKey);
  }, 5000);
}

function cleanJsonResponse(content) {
  if (typeof content !== 'string') return content;
  const trimmed = content.trim();
  if (trimmed.startsWith('```json')) return trimmed.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  if (trimmed.startsWith('```')) return trimmed.replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return content;
}

function fetchUrlBuffer(url, callback) {
  const client = url.startsWith('https://') ? https : http;
  const req = client.get(url, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      fetchUrlBuffer(res.headers.location, callback);
      res.resume();
      return;
    }
    if (res.statusCode !== 200) {
      callback(new Error('download failed: HTTP ' + res.statusCode));
      res.resume();
      return;
    }
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', function () {
      callback(null, Buffer.concat(chunks), res.headers['content-type'] || 'application/octet-stream');
    });
  });
  req.on('error', callback);
  req.setTimeout(30000, function () {
    req.destroy(new Error('download timeout'));
  });
}

function processImageUrls(messages, callback) {
  const tasks = [];

  (messages || []).forEach(function (message, mi) {
    if (!Array.isArray(message.content)) return;
    message.content.forEach(function (part, pi) {
      const url = part && part.type === 'image_url' && part.image_url && part.image_url.url;
      if (url && !url.startsWith('data:')) {
        tasks.push({ mi, pi, url });
      }
    });
  });

  if (!tasks.length) {
    callback(messages);
    return;
  }

  let pending = tasks.length;
  tasks.forEach(function (task) {
    fetchUrlBuffer(task.url, function (error, buffer, contentType) {
      if (!error && buffer) {
        messages[task.mi].content[task.pi].image_url.url = `data:${contentType};base64,${buffer.toString('base64')}`;
        stats.imageConversions += 1;
      } else {
        console.log('[WARN] 图片转 base64 失败:', task.url, error ? error.message : 'unknown');
      }

      pending -= 1;
      if (pending === 0) callback(messages);
    });
  });
}

function normalizeStreamChunk(chunk) {
  const text = chunk.toString('utf-8');
  const lines = text.split('\n');
  const out = [];

  for (const line of lines) {
    if (!line.startsWith('data: ')) {
      out.push(line);
      continue;
    }

    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') {
      out.push(line);
      continue;
    }

    try {
      const json = JSON.parse(payload);
      const choices = Array.isArray(json.choices) ? json.choices : [];
      for (const choice of choices) {
        if (choice.delta && choice.delta.reasoning_content) {
          choice.delta.content = `<think>\n${choice.delta.reasoning_content}\n</think>\n\n` + (choice.delta.content || '');
          delete choice.delta.reasoning_content;
        }
      }
      out.push('data: ' + JSON.stringify(json));
    } catch (_) {
      out.push(line);
    }
  }

  return out.join('\n');
}

function formatModels() {
  const models = CONFIG.models || DEFAULT_CONFIG.models || [];
  return {
    object: 'list',
    data: models.map(function (m) {
      return {
        id: m.id,
        object: 'model',
        created: Math.floor(stats.startTime / 1000),
        owned_by: 'moonshot'
      };
    })
  };
}

function shouldInjectThinking(modelId) {
  if (!CONFIG.auto_thinking) return false;
  const models = CONFIG.models || DEFAULT_CONFIG.models || [];
  const entry = models.find(function (m) { return m.id === modelId; });
  if (entry && entry.thinking === false) return false;
  return true;
}

function formatHealth() {
  const enabledKeys = keyPool.filter(k => k.enabled).length;
  return {
    status: enabledKeys > 0 ? 'ok' : 'degraded',
    version: VERSION,
    uptime_seconds: Math.floor((Date.now() - stats.startTime) / 1000),
    total_keys: keyPool.length,
    enabled_keys: enabledKeys,
    target_host: CONFIG.target_host,
    target_path_prefix: CONFIG.target_path_prefix,
    features: ['thinking', 'vision', 'function_call', 'stream', 'json_clean', 'multi_key', 'feishu_alert', 'metrics', 'env_override'],
    keys: keyPool.map(function (k) {
      return {
        name: k.name,
        note: k.note || '',
        enabled: k.enabled,
        weight: k.weight,
        requests: k.requestCount,
        errors: k.errorCount,
        consecutive_errors: k.consecutiveErrors,
        disable_tier: k.disableTier,
        rpm_current: k.minuteRequests.length,
        disabled_until: k.disabledUntil || null,
        last_used: k.lastUsed || null,
        last_error: k.lastError || null,
        probe_status: k.probeStatus,
        last_probe_at: k.lastProbeAt || null
      };
    })
  };
}

function formatMetrics() {
  const lines = [];
  lines.push('# HELP kimi_proxy_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE kimi_proxy_uptime_seconds gauge');
  lines.push(`kimi_proxy_uptime_seconds ${Math.floor((Date.now() - stats.startTime) / 1000)}`);
  lines.push('# HELP kimi_proxy_requests_total Total incoming requests');
  lines.push('# TYPE kimi_proxy_requests_total counter');
  lines.push(`kimi_proxy_requests_total ${stats.requestsTotal}`);
  lines.push('# HELP kimi_proxy_requests_succeeded_total Successful upstream responses');
  lines.push('# TYPE kimi_proxy_requests_succeeded_total counter');
  lines.push(`kimi_proxy_requests_succeeded_total ${stats.requestsSucceeded}`);
  lines.push('# HELP kimi_proxy_requests_failed_total Failed upstream responses');
  lines.push('# TYPE kimi_proxy_requests_failed_total counter');
  lines.push(`kimi_proxy_requests_failed_total ${stats.requestsFailed}`);
  lines.push('# HELP kimi_proxy_retries_total Total retry attempts');
  lines.push('# TYPE kimi_proxy_retries_total counter');
  lines.push(`kimi_proxy_retries_total ${stats.retriesTotal}`);
  lines.push('# HELP kimi_proxy_image_conversions_total Total image URL to base64 conversions');
  lines.push('# TYPE kimi_proxy_image_conversions_total counter');
  lines.push(`kimi_proxy_image_conversions_total ${stats.imageConversions}`);
  lines.push('# HELP kimi_proxy_upstream_network_errors_total Upstream network errors');
  lines.push('# TYPE kimi_proxy_upstream_network_errors_total counter');
  lines.push(`kimi_proxy_upstream_network_errors_total ${stats.upstreamNetworkErrors}`);
  lines.push('# HELP kimi_proxy_upstream_http_errors_total Upstream HTTP errors');
  lines.push('# TYPE kimi_proxy_upstream_http_errors_total counter');
  lines.push(`kimi_proxy_upstream_http_errors_total ${stats.upstreamHttpErrors}`);
  lines.push('# HELP kimi_proxy_key_enabled Key enable state');
  lines.push('# TYPE kimi_proxy_key_enabled gauge');
  keyPool.forEach(function (key) {
    lines.push(`kimi_proxy_key_enabled{name="${key.name}"} ${key.enabled ? 1 : 0}`);
    lines.push(`kimi_proxy_key_requests_total{name="${key.name}"} ${key.requestCount}`);
    lines.push(`kimi_proxy_key_errors_total{name="${key.name}"} ${key.errorCount}`);
    lines.push(`kimi_proxy_key_rpm_current{name="${key.name}"} ${key.minuteRequests.length}`);
  });
  return lines.join('\n') + '\n';
}

function proxyRequest(req, res, bodyStr, keyObj, retryCount) {
  const upstreamPath = `${CONFIG.target_path_prefix || ''}${req.url}`;
  const headers = Object.assign({}, req.headers, {
    host: CONFIG.target_host,
    authorization: `Bearer ${keyObj.key}`,
    'user-agent': CONFIG.coding_ua || DEFAULT_CONFIG.coding_ua,
    'content-length': Buffer.byteLength(bodyStr)
  });

  const options = {
    hostname: CONFIG.target_host,
    port: 443,
    path: upstreamPath,
    method: req.method,
    headers,
    timeout: CONFIG.request_timeout_ms || 120000
  };

  const proxyReq = https.request(options, function (proxyRes) {
    const isStream = String(proxyRes.headers['content-type'] || '').includes('text/event-stream');

    if (proxyRes.statusCode >= 400) {
      stats.upstreamHttpErrors += 1;
    }

    if (isStream) {
      const isError = proxyRes.statusCode >= 400;
      if (isError && retryCount < (CONFIG.max_retries || 2) && shouldRetryStatus(proxyRes.statusCode)) {
        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', function () {
          const errBody = Buffer.concat(chunks).toString('utf-8');
          if (isQuotaError(proxyRes.statusCode, errBody)) markKeyQuotaExhausted(keyObj);
          else if (proxyRes.statusCode === 401) markKeyDead(keyObj, `HTTP 401: ${errBody.slice(0,200)}`);
          else markKeyError(keyObj, `HTTP ${proxyRes.statusCode}`, { transient: true });
          const nextKey = getNextKey(keyObj);
          if (nextKey) {
            console.log(`[INFO] HTTP ${proxyRes.statusCode} on ${keyObj.name}, 切换到 ${nextKey.name} 重试`);
            stats.retriesTotal += 1;
            proxyRequest(req, res, bodyStr, nextKey, retryCount + 1);
          } else {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.end(errBody);
            stats.requestsFailed += 1;
          }
        });
        return;
      }

      let errorBody = '';
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.on('data', function (chunk) {
        if (isError) errorBody += chunk.toString('utf-8');
        try {
          res.write(normalizeStreamChunk(chunk));
        } catch (_) {
          res.write(chunk);
        }
      });
      proxyRes.on('end', function () {
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 400) {
          markKeySuccess(keyObj);
          stats.requestsSucceeded += 1;
        } else {
          if (isQuotaError(proxyRes.statusCode, errorBody)) {
            markKeyQuotaExhausted(keyObj);
          } else {
            const transient = proxyRes.statusCode === 429 || proxyRes.statusCode >= 500;
            markKeyError(keyObj, `HTTP ${proxyRes.statusCode}`, { transient });
          }
          stats.requestsFailed += 1;
        }
        res.end();
      });
      return;
    }

    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', function () {
      const respBody = Buffer.concat(chunks).toString('utf-8');

      if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 400) {
        markKeySuccess(keyObj);
        stats.requestsSucceeded += 1;
      } else {
        if (isQuotaError(proxyRes.statusCode, respBody)) {
          markKeyQuotaExhausted(keyObj);
        } else if (proxyRes.statusCode === 401) {
          markKeyDead(keyObj, `HTTP 401: ${respBody.slice(0, 200)}`);
        } else {
          const transient = proxyRes.statusCode === 429 || proxyRes.statusCode >= 500;
          markKeyError(keyObj, `HTTP ${proxyRes.statusCode}`, { transient });
        }
        stats.requestsFailed += 1;

        if (retryCount < (CONFIG.max_retries || 2) && shouldRetryStatus(proxyRes.statusCode, respBody)) {
          const nextKey = getNextKey(keyObj);
          if (nextKey) {
            console.log(`[INFO] HTTP ${proxyRes.statusCode} on ${keyObj.name}, 切换到 ${nextKey.name} 重试`);
            stats.retriesTotal += 1;
            proxyRequest(req, res, bodyStr, nextKey, retryCount + 1);
            return;
          }
        }
      }

      try {
        const data = JSON.parse(respBody);
        const isJsonMode = /json/i.test(bodyStr);
        if (Array.isArray(data.choices)) {
          data.choices.forEach(function (choice) {
            const msg = choice.message;
            if (!msg) return;
            if (msg.reasoning_content) {
              msg.content = `<think>\n${msg.reasoning_content}\n</think>\n\n${msg.content || ''}`;
              delete msg.reasoning_content;
            }
            if (isJsonMode && msg.content) {
              msg.content = cleanJsonResponse(msg.content);
            }
          });
        }
        const newBody = JSON.stringify(data);
        const newHeaders = Object.assign({}, proxyRes.headers, {
          'content-length': Buffer.byteLength(newBody)
        });
        res.writeHead(proxyRes.statusCode, newHeaders);
        res.end(newBody);
      } catch (_) {
        stats.parseFallbacks += 1;
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(respBody);
      }
    });
  });

  proxyReq.on('timeout', function () {
    proxyReq.destroy(new Error('upstream timeout'));
  });

  proxyReq.on('error', function (error) {
    console.log('[ERROR] Key', keyObj.name, '网络错误:', error.message);
    stats.upstreamNetworkErrors += 1;
    markKeyError(keyObj, error.message, { transient: true });

    if (retryCount < (CONFIG.max_retries || 2)) {
      const nextKey = getNextKey(keyObj);
      if (nextKey) {
        stats.retriesTotal += 1;
        proxyRequest(req, res, bodyStr, nextKey, retryCount + 1);
        return;
      }
    }

    stats.requestsFailed += 1;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'proxy: ' + error.message } }));
  });

  proxyReq.write(bodyStr);
  proxyReq.end();
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '***';
  return key.slice(0, 12) + '***' + key.slice(-4);
}

function adminAuthOk(req) {
  if (!CONFIG.admin || !CONFIG.admin.enabled) return false;
  const token = CONFIG.admin.token || '';
  if (!token) return false;
  const auth = req.headers['authorization'] || '';
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (!match) return false;
  return match[1] === token;
}

function adminSendJson(res, statusCode, body) {
  const s = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

function deriveKeyState(k, rpm) {
  if (k.probeStatus === 'invalid') return { level: 'dead', label: '失效', reason: 'HTTP 401 / key 过期' };
  if (k.probeStatus === 'forbidden') return { level: 'dead', label: '已屏蔽', reason: 'HTTP 403' };
  if (!k.enabled) {
    if (k.probeStatus === 'quota_exhausted' || k.lastError === 'quota exhausted') {
      return { level: 'quota', label: '额度耗尽', reason: '402 / 403 access_terminated' };
    }
    return { level: 'paused', label: '暂禁', reason: `退避 tier ${k.disableTier}` };
  }
  if (rpm && k.minuteRequests && k.minuteRequests.length >= rpm) {
    return { level: 'throttle', label: '限流', reason: `当前分钟已用 ${k.minuteRequests.length}/${rpm}` };
  }
  if (k.consecutiveErrors >= 2) {
    return { level: 'warn', label: '告警', reason: `连续 ${k.consecutiveErrors} 次错误` };
  }
  if (k.probeStatus && k.probeStatus !== 'healthy' && k.probeStatus.startsWith && k.probeStatus.startsWith('http_')) {
    return { level: 'warn', label: '探活异常', reason: k.probeStatus };
  }
  return { level: 'ok', label: '正常', reason: k.probeStatus || 'healthy' };
}

function adminListKeys() {
  const rpm = CONFIG.rate_limit_rpm || 30;
  return keyPool.map(function (k, idx) {
    const cfgKey = (CONFIG.keys || [])[idx] || {};
    const state = deriveKeyState(k, rpm);
    return {
      index: idx,
      name: k.name,
      note: k.note || '',
      key_masked: maskKey(k.key),
      weight: k.weight,
      enabled: k.enabled,
      config_enabled: cfgKey.enabled !== false,
      state_level: state.level,
      state_label: state.label,
      state_reason: state.reason,
      requests: k.requestCount,
      errors: k.errorCount,
      consecutive_errors: k.consecutiveErrors,
      disable_tier: k.disableTier,
      rpm_current: k.minuteRequests.length,
      rpm_limit: rpm,
      disabled_until: k.disabledUntil || null,
      last_used: k.lastUsed || null,
      last_error: k.lastError || null,
      probe_status: k.probeStatus,
      last_probe_at: k.lastProbeAt || null
    };
  });
}

function adminApplyChange(mutator, res) {
  try {
    const next = JSON.parse(JSON.stringify(CONFIG.keys || []));
    mutator(next);
    CONFIG.keys = next;
    saveConfigToDisk();
    initKeyPool();
    adminSendJson(res, 200, { ok: true, keys: adminListKeys() });
  } catch (error) {
    console.log('[ERROR] admin write failed:', error.message);
    adminSendJson(res, 500, { ok: false, error: error.message });
  }
}

const ADMIN_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kimi Proxy · Key 管理</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:24px;background:#0f172a;color:#e2e8f0;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
h1{margin:0 0 16px;font-size:20px}
.bar{display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
.stat{background:#1e293b;padding:8px 14px;border-radius:8px;font-size:12px;color:#94a3b8}
.stat b{color:#f1f5f9;font-size:16px;margin-right:4px}
button{background:#3b82f6;color:white;border:0;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:13px}
button:hover{background:#2563eb}
button.secondary{background:#334155}
button.secondary:hover{background:#475569}
button.danger{background:#dc2626}
button.danger:hover{background:#b91c1c}
button:disabled{opacity:.5;cursor:not-allowed}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #334155;font-size:13px}
th{background:#0f172a;font-weight:600;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
tr:last-child td{border-bottom:0}
tr:hover td{background:#1e293b}
input,textarea{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:6px 10px;border-radius:5px;font:inherit;width:100%}
input:focus,textarea:focus{border-color:#3b82f6;outline:0}
.pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;cursor:help}
.pill-ok{background:#064e3b;color:#6ee7b7}
.pill-throttle{background:#713f12;color:#fde68a}
.pill-warn{background:#78350f;color:#fcd34d}
.pill-paused{background:#3f1d7a;color:#c4b5fd}
.pill-quota{background:#7c2d12;color:#fdba74}
.pill-dead{background:#7f1d1d;color:#fca5a5}
.status-cell{display:flex;flex-direction:column;gap:2px;align-items:flex-start}
.rpm-bar{width:60px;height:4px;background:#334155;border-radius:2px;overflow:hidden}
.rpm-bar>div{height:100%;background:#3b82f6;transition:width .3s}
.rpm-bar.hot>div{background:#f97316}
.rpm-bar.full>div{background:#dc2626}
.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:#94a3b8}
.actions{display:flex;gap:6px}
.actions button{padding:4px 10px;font-size:12px}
dialog{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:12px;padding:24px;min-width:420px;max-width:90vw}
dialog::backdrop{background:rgba(0,0,0,.6)}
.field{margin-bottom:12px}
.field label{display:block;margin-bottom:4px;color:#94a3b8;font-size:12px}
.row{display:flex;gap:8px;margin-top:16px;justify-content:flex-end}
.error{background:#7f1d1d;color:#fca5a5;padding:8px 12px;border-radius:6px;margin-bottom:12px}
.muted{color:#64748b;font-size:12px}
</style>
</head>
<body>
<h1>Kimi Proxy · Key 管理</h1>
<div class="bar" id="stats"></div>
<div class="bar">
  <button id="addBtn">+ 添加 Key</button>
  <button class="secondary" id="refreshBtn">刷新</button>
  <button class="secondary" id="probeBtn" title="向所有 key 发一条极小探测请求，确认真实状态">🔬 立即检测</button>
  <span class="muted" id="lastUpdate"></span>
  <span class="muted" id="nextProbe"></span>
</div>
<div id="err"></div>
<table>
<thead><tr><th>#</th><th>名称</th><th>备注</th><th>Key</th><th>状态</th><th>权重</th><th>请求数</th><th>错误</th><th>最后错误</th><th>操作</th></tr></thead>
<tbody id="rows"></tbody>
</table>

<dialog id="dlg">
<h3 style="margin:0 0 16px">添加 / 编辑 Key</h3>
<div id="dlgErr"></div>
<div class="field"><label>Key</label><input id="f_key" placeholder="sk-kimi-..."></div>
<div class="field"><label>名称</label><input id="f_name" placeholder="kimi-coding-1"></div>
<div class="field"><label>备注</label><input id="f_note" placeholder="支付宝充值，2026-04-18"></div>
<div class="field"><label>权重 (默认 1)</label><input id="f_weight" type="number" min="0.1" step="0.1" value="1"></div>
<div class="row"><button class="secondary" id="dlgCancel">取消</button><button id="dlgSave">保存</button></div>
</dialog>

<script>
const TOKEN_KEY = 'kimi-admin-token';
let token = sessionStorage.getItem(TOKEN_KEY) || '';
if (!token) {
  token = prompt('请输入管理员 Token') || '';
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
}

async function api(method, path, body) {
  const r = await fetch(path, {
    method, headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 401 || r.status === 403) {
    sessionStorage.removeItem(TOKEN_KEY);
    location.reload();
    return;
  }
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

function fmtCountdown(ts) {
  if (!ts) return '';
  const secs = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (secs <= 0) return '';
  if (secs < 60) return secs + 's';
  if (secs < 3600) return Math.round(secs/60) + 'min';
  if (secs < 86400) return Math.round(secs/3600) + 'h';
  return Math.round(secs/86400) + 'd';
}

function pill(k) {
  const cls = 'pill-' + k.state_level;
  const title = (k.state_reason || '').replace(/"/g, '&quot;');
  let extra = '';
  if (k.disabled_until && k.state_level !== 'dead') {
    const cd = fmtCountdown(k.disabled_until);
    if (cd) extra = ' <span class="muted" style="font-size:10px">' + cd + '</span>';
  }
  return '<span class="pill ' + cls + '" title="' + title + '">' + k.state_label + '</span>' + extra;
}

function rpmBar(k) {
  const pct = Math.min(100, Math.round((k.rpm_current / k.rpm_limit) * 100));
  const cls = pct >= 100 ? 'full' : (pct >= 80 ? 'hot' : '');
  return '<div class="rpm-bar ' + cls + '"><div style="width:' + pct + '%"></div></div>'
    + '<span class="muted" style="font-size:11px">' + k.rpm_current + '/' + k.rpm_limit + ' rpm</span>';
}

function render(data) {
  const tbody = document.getElementById('rows');
  tbody.innerHTML = data.keys.map(function(k) {
    const note = (k.note || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    return '<tr>'
      + '<td>' + (k.index+1) + '</td>'
      + '<td>' + k.name + '</td>'
      + '<td><span class="muted">' + (note || '-') + '</span></td>'
      + '<td class="mono">' + k.key_masked + '</td>'
      + '<td><div class="status-cell">' + pill(k) + rpmBar(k) + '</div></td>'
      + '<td>' + k.weight + '</td>'
      + '<td>' + k.requests + '</td>'
      + '<td>' + k.errors + (k.consecutive_errors ? ' <span class="muted">(连续 '+k.consecutive_errors+')</span>' : '') + '</td>'
      + '<td class="muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (k.last_error || '-') + '</td>'
      + '<td><div class="actions">'
      + '<button class="secondary" onclick="edit(' + k.index + ')">编辑</button>'
      + '<button class="' + (k.enabled ? 'secondary' : '') + '" onclick="toggle(' + k.index + ',' + (!k.enabled) + ')">' + (k.enabled ? '禁用' : '启用') + '</button>'
      + '<button class="danger" onclick="del(' + k.index + ')">删除</button>'
      + '</div></td></tr>';
  }).join('');

  const totalReq = data.keys.reduce((s,k)=>s+k.requests,0);
  const totalErr = data.keys.reduce((s,k)=>s+k.errors,0);
  const counts = {};
  data.keys.forEach(k => counts[k.state_level] = (counts[k.state_level] || 0) + 1);
  const statOrder = [
    ['ok', '正常'], ['throttle', '限流'], ['warn', '告警'],
    ['paused', '暂禁'], ['quota', '额度耗尽'], ['dead', '失效']
  ];
  const statParts = statOrder.filter(([lv]) => counts[lv])
    .map(([lv, label]) => '<div class="stat pill-' + lv + '" style="color:inherit"><b>' + counts[lv] + '</b> ' + label + '</div>');
  document.getElementById('stats').innerHTML =
    '<div class="stat"><b>' + data.keys.length + '</b> 总 key</div>'
    + statParts.join('')
    + '<div class="stat"><b>' + totalReq + '</b> 总请求</div>'
    + '<div class="stat"><b>' + totalErr + '</b> 总错误</div>';
  document.getElementById('lastUpdate').textContent = '更新于 ' + new Date().toLocaleTimeString();
}

let cached = [];
async function load() {
  try {
    const d = await api('GET', '/admin/api/keys');
    if (d) { cached = d.keys; render(d); }
  } catch (e) {
    document.getElementById('err').innerHTML = '<div class="error">' + e.message + '</div>';
  }
}

const dlg = document.getElementById('dlg');
let editingIdx = null;

document.getElementById('addBtn').onclick = () => {
  editingIdx = null;
  document.getElementById('f_key').value = '';
  document.getElementById('f_name').value = '';
  document.getElementById('f_note').value = '';
  document.getElementById('f_weight').value = '1';
  document.getElementById('f_key').disabled = false;
  document.getElementById('dlgErr').innerHTML = '';
  dlg.showModal();
};
document.getElementById('refreshBtn').onclick = load;

const PROBE_INTERVAL_MS = 20 * 60 * 1000;
let lastProbeAt = 0;
let nextProbeAt = Date.now() + PROBE_INTERVAL_MS;

async function runProbe(triggered) {
  const btn = document.getElementById('probeBtn');
  btn.disabled = true;
  btn.textContent = triggered === 'auto' ? '⏱ 自动检测中...' : '🔬 检测中...';
  try {
    await api('POST', '/admin/api/probe');
    await new Promise(r => setTimeout(r, 3500));
    await load();
    lastProbeAt = Date.now();
    nextProbeAt = lastProbeAt + PROBE_INTERVAL_MS;
  } catch (e) {
    document.getElementById('err').innerHTML = '<div class="error">检测失败: ' + e.message + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = '🔬 立即检测';
  }
}

document.getElementById('probeBtn').onclick = () => runProbe('manual');

function updateNextProbe() {
  const el = document.getElementById('nextProbe');
  const remain = Math.max(0, nextProbeAt - Date.now());
  if (!lastProbeAt) { el.textContent = ''; return; }
  const mins = Math.floor(remain / 60000);
  const secs = Math.floor((remain % 60000) / 1000);
  el.textContent = '下次自动检测 ' + (mins > 0 ? mins + 'm' : secs + 's');
}
setInterval(updateNextProbe, 1000);

setInterval(function () {
  if (Date.now() >= nextProbeAt) runProbe('auto');
}, 30000);
document.getElementById('dlgCancel').onclick = () => dlg.close();
document.getElementById('dlgSave').onclick = async () => {
  const payload = {
    key: document.getElementById('f_key').value.trim(),
    name: document.getElementById('f_name').value.trim(),
    note: document.getElementById('f_note').value.trim(),
    weight: parseFloat(document.getElementById('f_weight').value) || 1
  };
  try {
    if (editingIdx === null) {
      await api('POST', '/admin/api/keys', payload);
    } else {
      delete payload.key;
      await api('PATCH', '/admin/api/keys/' + editingIdx, payload);
    }
    dlg.close();
    load();
  } catch (e) {
    document.getElementById('dlgErr').innerHTML = '<div class="error">' + e.message + '</div>';
  }
};

window.edit = function(idx) {
  editingIdx = idx;
  const k = cached.find(x => x.index === idx);
  document.getElementById('f_key').value = k.key_masked;
  document.getElementById('f_key').disabled = true;
  document.getElementById('f_name').value = k.name;
  document.getElementById('f_note').value = k.note || '';
  document.getElementById('f_weight').value = k.weight;
  document.getElementById('dlgErr').innerHTML = '';
  dlg.showModal();
};
window.toggle = async function(idx, enabled) {
  try { await api('PATCH', '/admin/api/keys/' + idx, { enabled }); load(); }
  catch(e) { document.getElementById('err').innerHTML = '<div class="error">' + e.message + '</div>'; }
};
window.del = async function(idx) {
  const k = cached.find(x => x.index === idx);
  if (!confirm('确认删除 ' + k.name + ' ?')) return;
  try { await api('DELETE', '/admin/api/keys/' + idx); load(); }
  catch(e) { document.getElementById('err').innerHTML = '<div class="error">' + e.message + '</div>'; }
};

(async () => {
  await load();
  await runProbe('auto');
})();
setInterval(load, 15000);
</script>
</body>
</html>`;

function handleAdminRequest(req, res) {
  if (!CONFIG.admin || !CONFIG.admin.enabled) {
    res.writeHead(404);
    res.end('admin disabled');
    return true;
  }

  if (req.url === '/admin' || req.url === '/admin/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ADMIN_HTML);
    return true;
  }

  if (!req.url.startsWith('/admin/api/')) return false;

  if (!adminAuthOk(req)) {
    adminSendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (req.url === '/admin/api/keys' && req.method === 'GET') {
    adminSendJson(res, 200, { keys: adminListKeys() });
    return true;
  }

  if (req.url === '/admin/api/probe' && req.method === 'POST') {
    let triggered = 0;
    keyPool.forEach(function (key) {
      probeKey(key);
      triggered += 1;
    });
    console.log(`[INFO] 管理端手动触发探活: ${triggered} 个 key`);
    adminSendJson(res, 200, { ok: true, triggered });
    return true;
  }

  if (req.url === '/admin/api/keys' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', function () {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.key || typeof payload.key !== 'string') {
          return adminSendJson(res, 400, { error: 'key 必填' });
        }
        adminApplyChange(function (keys) {
          keys.push({
            key: payload.key.trim(),
            name: (payload.name || '').trim() || `key-${keys.length + 1}`,
            note: (payload.note || '').trim(),
            weight: typeof payload.weight === 'number' ? payload.weight : 1
          });
        }, res);
      } catch (error) {
        adminSendJson(res, 400, { error: error.message });
      }
    });
    return true;
  }

  const match = req.url.match(/^\/admin\/api\/keys\/(\d+)$/);
  if (match) {
    const idx = parseInt(match[1], 10);

    if (req.method === 'DELETE') {
      adminApplyChange(function (keys) {
        if (idx < 0 || idx >= keys.length) throw new Error('index 越界');
        keys.splice(idx, 1);
      }, res);
      return true;
    }

    if (req.method === 'PATCH') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', function () {
        try {
          const payload = JSON.parse(body || '{}');
          const forceEnable = payload.enabled === true;
          adminApplyChange(function (keys) {
            if (idx < 0 || idx >= keys.length) throw new Error('index 越界');
            const k = keys[idx];
            if (typeof payload.name === 'string') k.name = payload.name.trim() || k.name;
            if (typeof payload.note === 'string') k.note = payload.note.trim();
            if (typeof payload.weight === 'number') k.weight = payload.weight;
            if (typeof payload.enabled === 'boolean') k.enabled = payload.enabled;
          }, res);
          if (forceEnable) {
            const pooled = keyPool[idx];
            if (pooled) {
              pooled.enabled = true;
              pooled.disabledUntil = 0;
              pooled.consecutiveErrors = 0;
              pooled.disableTier = 0;
              pooled.probeStatus = null;
              console.log(`[INFO] 管理端手动启用 ${pooled.name}，清空运行时禁用状态`);
            }
          }
        } catch (error) {
          adminSendJson(res, 400, { error: error.message });
        }
      });
      return true;
    }
  }

  adminSendJson(res, 404, { error: 'not found' });
  return true;
}

const server = http.createServer(function (req, res) {
  if (req.url === '/health' || req.url === '/ready' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(formatHealth(), null, 2));
    return;
  }

  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(formatMetrics());
    return;
  }

  if (req.url === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(formatModels()));
    return;
  }

  if (req.url === '/admin' || req.url.startsWith('/admin/')) {
    if (handleAdminRequest(req, res)) return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', function () {
    stats.requestsTotal += 1;
    stats.lastRequestAt = Date.now();
    markRoute(req.url);

    const keyObj = getNextKey();
    if (!keyObj) {
      stats.requestsFailed += 1;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '所有 key 不可用', type: 'service_unavailable' } }));
      sendFeishu('[Kimi Proxy] 所有 Key 不可用，服务降级');
      return;
    }

    try {
      const json = JSON.parse(body || '{}');

      if (!json.thinking && shouldInjectThinking(json.model)) {
        json.thinking = {
          type: 'enabled',
          budget_tokens: CONFIG.thinking_budget_tokens || 512
        };
      }
      if (json.enable_thinking !== undefined) {
        delete json.enable_thinking;
      }

      const forcedTemps = CONFIG.force_temperature || {};
      if (json.model && typeof forcedTemps[json.model] === 'number') {
        json.temperature = forcedTemps[json.model];
      }

      if (Array.isArray(json.messages)) {
        json.messages.forEach(function (message) {
          if (message.role === 'assistant' && message.tool_calls && !message.reasoning_content) {
            message.reasoning_content = 'ok';
          }
        });
      }

      let hasImageUrl = false;
      if (Array.isArray(json.messages)) {
        for (const message of json.messages) {
          if (!Array.isArray(message.content)) continue;
          for (const part of message.content) {
            if (part && part.type === 'image_url' && part.image_url && part.image_url.url && !part.image_url.url.startsWith('data:')) {
              hasImageUrl = true;
              break;
            }
          }
          if (hasImageUrl) break;
        }
      }

      if (hasImageUrl) {
        console.log(`[${nowIso()}] ${req.method} ${req.url} → key:${keyObj.name} (downloading images...)`);
        processImageUrls(json.messages, function (messages) {
          json.messages = messages;
          proxyRequest(req, res, JSON.stringify(json), keyObj, 0);
        });
      } else {
        console.log(`[${nowIso()}] ${req.method} ${req.url} → key:${keyObj.name}`);
        proxyRequest(req, res, JSON.stringify(json), keyObj, 0);
      }
    } catch (_) {
      console.log(`[${nowIso()}] ${req.method} ${req.url} → key:${keyObj.name} (raw)`);
      proxyRequest(req, res, body, keyObj, 0);
    }
  });
});

server.listen(CONFIG.port || 8919, CONFIG.host || '0.0.0.0', function () {
  console.log('========================================');
  console.log('  Kimi Thinking Proxy');
  console.log('  Version: ' + VERSION);
  console.log('  端口: ' + (CONFIG.port || 8919));
  console.log('  Host: ' + (CONFIG.host || '0.0.0.0'));
  console.log('  Upstream: https://' + CONFIG.target_host + (CONFIG.target_path_prefix || ''));
  console.log('  Key 数: ' + keyPool.length);
  console.log('  限流: ' + (CONFIG.rate_limit_rpm || 30) + ' RPM/key');
  console.log('  功能: 思考链 | 图片转Base64 | Function Call修复 | JSON清理 | 多Key轮询 | 飞书告警 | Metrics | 环境变量覆盖');
  console.log('========================================');
});
