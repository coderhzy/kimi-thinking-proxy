# kimi-thinking-proxy

A lightweight **OpenAI-compatible proxy** for **Kimi coding/thinking** endpoints.

## What it does

This proxy sits between your panel/client and Kimi upstream, and adds a few practical capabilities that generic gateways often miss:

- multi-key round-robin rotation
- per-key RPM limiting
- temporary circuit breaking after repeated failures
- auto recovery for disabled keys
- `enable_thinking` auto injection
- stream and non-stream `reasoning_content` adaptation into `<think>...</think>`
- remote image URL to base64 conversion for vision requests
- optional Telegram alerts
- health endpoint and Prometheus-style metrics
- file config + environment variable overrides

## Endpoints

- `POST /v1/chat/completions`
- `GET /health`
- `GET /ready`
- `GET /metrics`

## Quick start

```bash
cp config.example.json config.json
node server.js
```

Then point your client or panel to:

```bash
http://127.0.0.1:8919/v1/chat/completions
```

## Docker

```bash
docker compose up -d --build
```

## Example config

See `config.example.json`.

Key fields:

- `port`: local listen port
- `host`: local bind host
- `target_host`: upstream host, usually `api.kimi.com`
- `target_path_prefix`: upstream path prefix, e.g. `/coding`
- `keys`: multiple API keys for rotation
- `rate_limit_rpm`: per-key requests per minute
- `max_retries`: retry count on upstream/network failure
- `request_timeout_ms`: upstream timeout
- `auto_thinking`: inject `enable_thinking=true` when absent
- `telegram.enabled`: send basic failure alerts

## Environment variables

All important config values can be overridden with env vars:

- `PORT`
- `HOST`
- `CONFIG_PATH`
- `TARGET_HOST`
- `TARGET_PATH_PREFIX`
- `CODING_UA`
- `AUTO_THINKING`
- `RATE_LIMIT_RPM`
- `MAX_RETRIES`
- `REQUEST_TIMEOUT_MS`
- `KIMI_KEYS` (comma-separated)
- `TELEGRAM_ENABLED`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Example:

```bash
PORT=8919 \
TARGET_HOST=api.kimi.com \
TARGET_PATH_PREFIX=/coding \
KIMI_KEYS=sk-kimi-1,sk-kimi-2 \
node server.js
```

## Health check

```bash
curl http://127.0.0.1:8919/health
```

## Metrics

```bash
curl http://127.0.0.1:8919/metrics
```

Exports Prometheus-style plaintext metrics such as:

- `kimi_proxy_requests_total`
- `kimi_proxy_requests_succeeded_total`
- `kimi_proxy_requests_failed_total`
- `kimi_proxy_retries_total`
- `kimi_proxy_key_enabled{name="..."}`
- `kimi_proxy_key_requests_total{name="..."}`

## Design notes

This is intentionally dependency-light:

- no Express
- no Fastify
- no external proxy framework

It uses Node built-ins only, which makes it easy to audit and deploy.

## Recommended production setup

- run behind Nginx or Caddy
- keep `config.json` out of git
- use multiple Kimi keys if you need higher throughput
- scrape `/metrics` with Prometheus if you want observability
- place this behind your panel/gateway such as New API

## Security notes

- never commit real API keys
- rotate any key that was exposed
- treat Telegram tokens as secrets too
- prefer env vars or mounted config in production

## Roadmap

- structured JSON logs
- admin/debug endpoint
- pluggable provider adapters
- token usage accounting helpers
- unit tests

## License

MIT
