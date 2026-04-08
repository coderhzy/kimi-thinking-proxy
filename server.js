#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const VERSION = '0.2.0';
const DEFAULT_CONFIG_PATH = process.env.CONFIG_PATH || '/app/config.json';

const DEFAULT_CONFIG = {
  port: 8919,
  host: '0.0.0.0',
  target_host: 'api.kimi.com',
  target_path_prefix: '/coding',
  coding_ua: 'claude-cli/2.1.44 (external, sdk-cli)',
  auto_thinking: true,
  rate_limit_rpm: 30,
  max_retries: 2,
  request_timeout_ms: 120000,
  keys: [],
  feishu: {
    enabled: false,
    webhook: ''
  }
};

let CONFIG = loadConfig();
let keyPool = [];
let keyIndex = 0;
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
  return merged;
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
  });
}

function initKeyPool() {
  keyPool = (CONFIG.keys || []).map(function (item, index) {
    return {
      index,
      key: item.key,
      name: item.name || `key-${index + 1}`,
      enabled: item.enabled !== false,
      requestCount: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      lastError: '',
      lastErrorTime: 0,
      lastUsed: 0,
      minuteRequests: [],
      disabledUntil: 0
    };
  });
  keyIndex = 0;
  console.log('[INFO] Key 池初始化:', keyPool.length, '个 key');
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

function getNextKey() {
  if (!keyPool.length) return null;

  const total = keyPool.length;
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

  for (let offset = 0; offset < total; offset++) {
    const idx = (keyIndex + offset) % total;
    const candidate = keyPool[idx];
    if (!candidate.enabled) continue;
    if (candidate.disabledUntil && candidate.disabledUntil > now) continue;
    if (candidate.minuteRequests.length >= rpm) continue;

    keyIndex = (idx + 1) % total;
    candidate.requestCount += 1;
    candidate.lastUsed = now;
    candidate.minuteRequests.push(now);
    return candidate;
  }

  return null;
}

function markKeySuccess(keyObj) {
  if (!keyObj) return;
  keyObj.consecutiveErrors = 0;
  keyObj.lastError = '';
}

function isQuotaError(statusCode, body) {
  if (statusCode === 402) return true;
  if (statusCode === 429) {
    const text = (body || '').toLowerCase();
    if (/quota|balance|insufficient|exceeded|limit/.test(text)) return true;
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

function markKeyError(keyObj, message) {
  if (!keyObj) return;
  keyObj.errorCount += 1;
  keyObj.consecutiveErrors += 1;
  keyObj.lastError = message || 'unknown error';
  keyObj.lastErrorTime = Date.now();

  if (keyObj.consecutiveErrors >= 3) {
    keyObj.enabled = false;
    keyObj.disabledUntil = Date.now() + 24 * 60 * 60 * 1000;
    console.log('[WARN] Key', keyObj.name, '连续失败，禁用 1 天');
    sendFeishu(`[Kimi Proxy] Key ${keyObj.name} 连续失败，已禁用 1 天\n原因: ${keyObj.lastError}`);
  }
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
        enabled: k.enabled,
        requests: k.requestCount,
        errors: k.errorCount,
        consecutive_errors: k.consecutiveErrors,
        rpm_current: k.minuteRequests.length,
        disabled_until: k.disabledUntil || null,
        last_used: k.lastUsed || null,
        last_error: k.lastError || null
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
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.on('data', function (chunk) {
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
          if (isQuotaError(proxyRes.statusCode, '')) {
            markKeyQuotaExhausted(keyObj);
          } else {
            markKeyError(keyObj, `HTTP ${proxyRes.statusCode}`);
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
        } else {
          markKeyError(keyObj, `HTTP ${proxyRes.statusCode}`);
        }
        stats.requestsFailed += 1;
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
    markKeyError(keyObj, error.message);

    if (retryCount < (CONFIG.max_retries || 2)) {
      const nextKey = getNextKey();
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

      if (CONFIG.auto_thinking && json.enable_thinking === undefined) {
        json.enable_thinking = true;
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
