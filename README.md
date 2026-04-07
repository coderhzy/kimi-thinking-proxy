# kimi-thinking-proxy

A lightweight OpenAI-compatible proxy for **Kimi coding/thinking** endpoints.

## Features

- Multi-key round-robin rotation
- Per-key RPM limiting
- Automatic retry and temporary circuit breaking
- `/health` status endpoint
- Auto-inject `enable_thinking`
- Stream and non-stream reasoning conversion to `<think>...</think>`
- Remote image URL to base64 conversion for vision requests
- Optional Telegram alerts
- Hot-reload config file

## Why this exists

Kimi's coding/thinking flow may need a thin compatibility layer for:

- custom upstream path prefixes like `/coding`
- reasoning/thinking field adaptation
- multi-key scheduling
- panel/gateway integration

This project provides that adapter layer.

## Quick start

```bash
cp config.example.json config.json
# edit config.json with your own keys
node server.js
```

Then send OpenAI-compatible requests to:

```bash
http://localhost:8919/v1/chat/completions
```

## Docker

```bash
docker compose up -d --build
```

## Config

See `config.example.json`.

Important fields:

- `target_host`: upstream host, e.g. `api.kimi.com`
- `target_path_prefix`: upstream path prefix, e.g. `/coding`
- `keys`: multiple API keys for round-robin rotation
- `rate_limit_rpm`: requests per minute per key
- `max_retries`: retry count when a key fails
- `auto_thinking`: inject `enable_thinking=true` when missing

## Health check

```bash
curl http://127.0.0.1:8919/health
```

## Security notes

- Never commit real API keys
- Keep `config.json` out of version control
- Rotate any key that was ever exposed

## Roadmap

- metrics endpoint
- admin status page
- configurable backoff strategy
- structured logging
- provider adapter abstraction
