const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ==================== 配置加载 ====================
const CONFIG_PATH = process.env.CONFIG_PATH || "/app/config.json";
let CONFIG = loadConfig();

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    console.error("[ERROR] 加载配置失败:", e.message);
    return {
      port: 8919, target_host: "api.kimi.com", target_path_prefix: "/coding",
      coding_ua: "claude-cli/2.1.44 (external, sdk-cli)", auto_thinking: true,
      keys: [], rate_limit_rpm: 30, max_retries: 2,
      telegram: { enabled: false, bot_token: "", chat_id: "" },
    };
  }
}

fs.watchFile(CONFIG_PATH, { interval: 10000 }, function () {
  console.log("[INFO] 配置文件变化，重新加载...");
  CONFIG = loadConfig();
  initKeyPool();
});

// ==================== Key 池管理 ====================
var keyPool = [];
var keyIndex = 0;

function initKeyPool() {
  keyPool = (CONFIG.keys || []).map(function (k, i) {
    return {
      index: i, key: typeof k === "string" ? k : k.key,
      name: typeof k === "string" ? "key-" + i : k.name || "key-" + i,
      enabled: true, requestCount: 0, errorCount: 0, consecutiveErrors: 0,
      lastError: null, lastErrorTime: 0, lastUsed: 0, minuteRequests: [], disabledUntil: 0,
    };
  });
  keyIndex = 0;
  console.log("[INFO] Key 池初始化:", keyPool.length, "个 key");
}
initKeyPool();

function getNextKey() {
  var now = Date.now(), rpm = CONFIG.rate_limit_rpm || 30, cutoff = now - 60000;
  for (var k of keyPool) {
    k.minuteRequests = k.minuteRequests.filter(function (t) { return t > cutoff; });
    if (!k.enabled && k.disabledUntil > 0 && now > k.disabledUntil) {
      k.enabled = true; k.consecutiveErrors = 0;
      console.log("[INFO] Key", k.name, "自动恢复");
    }
  }
  var tried = 0;
  while (tried < keyPool.length) {
    var idx = keyIndex % keyPool.length; keyIndex++;
    var key = keyPool[idx];
    if (!key.enabled || key.minuteRequests.length >= rpm) { tried++; continue; }
    key.minuteRequests.push(now); key.lastUsed = now; key.requestCount++;
    return key;
  }
  return null;
}

function markKeyError(keyObj, errorMsg) {
  keyObj.errorCount++; keyObj.consecutiveErrors++;
  keyObj.lastError = errorMsg; keyObj.lastErrorTime = Date.now();
  if (keyObj.consecutiveErrors >= 3) {
    keyObj.enabled = false; keyObj.disabledUntil = Date.now() + 300000;
    console.log("[WARN] Key", keyObj.name, "连续失败", keyObj.consecutiveErrors, "次，禁用5分钟");
    sendTelegram("⚠️ *Kimi Proxy Key 异常*\nKey: `" + keyObj.name + "`\n错误: " + errorMsg + "\n已禁用 5 分钟");
  }
}

function markKeySuccess(keyObj) { keyObj.consecutiveErrors = 0; }

// ==================== Telegram 通知 ====================
function sendTelegram(msg) {
  if (!CONFIG.telegram || !CONFIG.telegram.enabled) return;
  var data = JSON.stringify({ chat_id: CONFIG.telegram.chat_id, text: msg, parse_mode: "Markdown" });
  var req = https.request({
    hostname: "api.telegram.org", port: 443, method: "POST",
    path: "/bot" + CONFIG.telegram.bot_token + "/sendMessage",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
  });
  req.on("error", function () {});
  req.write(data); req.end();
}

// ==================== 图片 URL → Base64 转换 ====================
function downloadImageToBase64(url, callback) {
  var client = url.startsWith("https") ? https : http;
  var req = client.get(url, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0" } }, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      downloadImageToBase64(res.headers.location, callback);
      return;
    }
    if (res.statusCode !== 200) { callback(null); return; }
    var chunks = [];
    res.on("data", function (c) { chunks.push(c); });
    res.on("end", function () {
      var buf = Buffer.concat(chunks);
      var ct = res.headers["content-type"] || "image/jpeg";
      var mime = ct.split(";")[0].trim();
      if (!mime.startsWith("image/")) mime = "image/jpeg";
      callback("data:" + mime + ";base64," + buf.toString("base64"));
    });
  });
  req.on("error", function () { callback(null); });
  req.on("timeout", function () { req.destroy(); callback(null); });
}

function processImageUrls(messages, callback) {
  var tasks = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    for (var j = 0; j < msg.content.length; j++) {
      var part = msg.content[j];
      if (part.type === "image_url" && part.image_url && part.image_url.url) {
        var url = part.image_url.url;
        if (!url.startsWith("data:")) {
          tasks.push({ msgIdx: i, partIdx: j, url: url });
        }
      }
    }
  }
  if (tasks.length === 0) { callback(messages); return; }

  var done = 0;
  for (var t = 0; t < tasks.length; t++) {
    (function (task) {
      downloadImageToBase64(task.url, function (b64) {
        if (b64) {
          messages[task.msgIdx].content[task.partIdx].image_url.url = b64;
        }
        done++;
        if (done === tasks.length) callback(messages);
      });
    })(tasks[t]);
  }
}

// ==================== JSON 响应清理 ====================
function cleanJsonResponse(content) {
  if (!content) return content;
  var trimmed = content.trim();
  if (trimmed.startsWith("```json") && trimmed.endsWith("```")) {
    return trimmed.slice(7, -3).trim();
  }
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.slice(3, -3).trim();
  }
  return content;
}

// ==================== 代理核心 ====================
function proxyRequest(req, res, bodyStr, keyObj, retryCount) {
  var isStream = bodyStr.indexOf('"stream":true') >= 0 || bodyStr.indexOf('"stream": true') >= 0;
  var isJsonMode = bodyStr.indexOf('"json_object"') >= 0 || bodyStr.indexOf('"json_schema"') >= 0;

  var targetPath = CONFIG.target_path_prefix + req.url;
  var options = {
    hostname: CONFIG.target_host, port: 443, path: targetPath, method: req.method,
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer " + keyObj.key,
      "user-agent": CONFIG.coding_ua,
      "content-length": Buffer.byteLength(bodyStr),
      "accept": req.headers["accept"] || "*/*",
    },
  };

  var proxyReq = https.request(options, function (proxyRes) {
    if (proxyRes.statusCode >= 400 && proxyRes.statusCode !== 400) {
      var errBody = "";
      proxyRes.on("data", function (c) { errBody += c; });
      proxyRes.on("end", function () {
        var errMsg = "HTTP " + proxyRes.statusCode;
        try { errMsg = JSON.parse(errBody).error.message || errMsg; } catch (e) {}
        console.log("[ERROR] Key", keyObj.name, ":", errMsg);
        markKeyError(keyObj, errMsg);
        if (retryCount < (CONFIG.max_retries || 2)) {
          var nextKey = getNextKey();
          if (nextKey) {
            console.log("[INFO] 重试", retryCount + 1, "→ key:", nextKey.name);
            proxyRequest(req, res, bodyStr, nextKey, retryCount + 1);
            return;
          }
        }
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(errBody);
        if (keyPool.filter(function (k) { return k.enabled; }).length === 0) {
          sendTelegram("🚨 *Kimi Proxy 全部 Key 不可用!*\n最后错误: " + errMsg);
        }
      });
      return;
    }

    markKeySuccess(keyObj);

    if (isStream) {
      var inThinking = false, thinkingStarted = false;
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      var buffer = "";
      proxyRes.on("data", function (chunk) {
        buffer += chunk.toString();
        var lines = buffer.split("\n"); buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line.startsWith("data: ") || line === "data: [DONE]") { res.write(line + "\n"); continue; }
          try {
            var data = JSON.parse(line.slice(6));
            var delta = data.choices && data.choices[0] && data.choices[0].delta;
            if (delta) {
              if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
                if (!thinkingStarted) { delta.content = "<think>" + (delta.reasoning_content || ""); thinkingStarted = true; inThinking = true; }
                else { delta.content = delta.reasoning_content; }
                delete delta.reasoning_content;
              } else if (delta.content !== undefined && inThinking) {
                delta.content = "</think>" + (delta.content || ""); inThinking = false;
              }
            }
            res.write("data: " + JSON.stringify(data) + "\n");
          } catch (e2) { res.write(line + "\n"); }
        }
      });
      proxyRes.on("end", function () { if (buffer) res.write(buffer); res.end(); });
    } else {
      var respBody = "";
      proxyRes.on("data", function (chunk) { respBody += chunk; });
      proxyRes.on("end", function () {
        try {
          var data = JSON.parse(respBody);
          var msg = data.choices && data.choices[0] && data.choices[0].message;
          if (msg) {
            if (msg.reasoning_content) {
              msg.content = "<think>\n" + msg.reasoning_content + "\n</think>\n\n" + (msg.content || "");
              delete msg.reasoning_content;
            }
            if (isJsonMode && msg.content) {
              msg.content = cleanJsonResponse(msg.content);
            }
          }
          var newBody = JSON.stringify(data);
          var newHeaders = Object.assign({}, proxyRes.headers);
          newHeaders["content-length"] = Buffer.byteLength(newBody);
          res.writeHead(proxyRes.statusCode, newHeaders);
          res.end(newBody);
        } catch (e3) {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(respBody);
        }
      });
    }
  });

  proxyReq.on("error", function (e) {
    console.log("[ERROR] Key", keyObj.name, "网络错误:", e.message);
    markKeyError(keyObj, e.message);
    if (retryCount < (CONFIG.max_retries || 2)) {
      var nextKey = getNextKey();
      if (nextKey) { proxyRequest(req, res, bodyStr, nextKey, retryCount + 1); return; }
    }
    res.writeHead(502);
    res.end(JSON.stringify({ error: { message: "proxy: " + e.message } }));
  });
  proxyReq.write(bodyStr);
  proxyReq.end();
}

// ==================== HTTP 服务 ====================
var server = http.createServer(function (req, res) {
  if (req.url === "/health" || req.url === "/") {
    var ek = keyPool.filter(function (k) { return k.enabled; }).length;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: ek > 0 ? "ok" : "degraded", version: "2.1.0",
      total_keys: keyPool.length, enabled_keys: ek,
      features: ["thinking", "vision", "function_call", "stream", "json_clean", "multi_key", "telegram_alert"],
      keys: keyPool.map(function (k) {
        return { name: k.name, enabled: k.enabled, requests: k.requestCount, errors: k.errorCount,
          consecutive_errors: k.consecutiveErrors, rpm_current: k.minuteRequests.length };
      }),
    }, null, 2));
    return;
  }

  var body = "";
  req.on("data", function (chunk) { body += chunk; });
  req.on("end", function () {
    var keyObj = getNextKey();
    if (!keyObj) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: { message: "所有 key 不可用", type: "service_unavailable" } }));
      sendTelegram("🚨 *Kimi Proxy*: 所有 Key 不可用");
      return;
    }

    // 解析请求体，处理图片和参数
    try {
      var json = JSON.parse(body);

      // 自动注入 enable_thinking
      if (CONFIG.auto_thinking && json.enable_thinking === undefined) {
        json.enable_thinking = true;
      }

      // 处理 Tool Call 多轮 - 自动补全 reasoning_content
      if (json.messages) {
        for (var i = 0; i < json.messages.length; i++) {
          var m = json.messages[i];
          if (m.role === "assistant" && m.tool_calls && !m.reasoning_content) {
            m.reasoning_content = "ok";
          }
        }
      }

      // 检查是否有图片 URL 需要转 base64
      var hasImageUrl = false;
      if (json.messages) {
        for (var i = 0; i < json.messages.length; i++) {
          if (!Array.isArray(json.messages[i].content)) continue;
          for (var j = 0; j < json.messages[i].content.length; j++) {
            var p = json.messages[i].content[j];
            if (p.type === "image_url" && p.image_url && p.image_url.url && !p.image_url.url.startsWith("data:")) {
              hasImageUrl = true; break;
            }
          }
          if (hasImageUrl) break;
        }
      }

      if (hasImageUrl) {
        console.log("[" + new Date().toISOString().slice(11, 19) + "] " + req.method + " " + req.url + " → key:" + keyObj.name + " (downloading images...)");
        processImageUrls(json.messages, function (msgs) {
          json.messages = msgs;
          var finalBody = JSON.stringify(json);
          proxyRequest(req, res, finalBody, keyObj, 0);
        });
      } else {
        var finalBody = JSON.stringify(json);
        console.log("[" + new Date().toISOString().slice(11, 19) + "] " + req.method + " " + req.url + " → key:" + keyObj.name);
        proxyRequest(req, res, finalBody, keyObj, 0);
      }
    } catch (e) {
      console.log("[" + new Date().toISOString().slice(11, 19) + "] " + req.method + " " + req.url + " → key:" + keyObj.name + " (raw)");
      proxyRequest(req, res, body, keyObj, 0);
    }
  });
});

var PORT = CONFIG.port || 8919;
server.listen(PORT, "0.0.0.0", function () {
  console.log("========================================");
  console.log("  Kimi Thinking Proxy");
  console.log("  端口: " + PORT);
  console.log("  Key 数: " + keyPool.length);
  console.log("  限流: " + (CONFIG.rate_limit_rpm || 30) + " RPM/key");
  console.log("  功能: 思考链 | 图片转Base64 | Function Call修复 | JSON清理 | 多Key轮询 | Telegram告警");
  console.log("========================================");
});
