# 三仔 API — W1 mock

Privacy-first tip + chat backend stub. Fortune/chart raw data stays server-side (`birth_vault`). Clients see product copy only. LLM chat never alters tips.

## Run

```bash
npm install
npm start          # PORT defaults to 3000
# or
npm run dev        # node --watch
```

Override bind with `PORT` / `HOST` (host defaults to `0.0.0.0`):

```bash
PORT=3000 npm start
```

**Client mock base URL:** `http://localhost:3000/v1`

The OpenAPI placeholder `https://api.example.local/v1` maps here in W1. Point Flutter (including web/dev) at `http://localhost:3000/v1`. CORS is enabled for local/dev origins.

## Contracts

- OpenAPI: `schemas/w1-openapi.yaml` (source of truth)
- JSON Schema: `schemas/*.schema.json`
- Mocks: `mocks/`

## Endpoints (W1)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/v1/tips/today` | ETag / 304; optional `Accept-Language` (zh-HK default) |
| GET | `/v1/me` | ETag / 304; never includes `birth_vault` |
| POST | `/v1/chat` | Locked persona + today's tip; `X-Force-Offline: 1` → 503 |
| GET | `/v1/reply-packs/current` | Offline FAQ pack; ETag / 304 |

Chat voice: blunt-but-kind friend; optional care; one daily action; no arguing; no occult terms. Replies may reference today's `action` / `why` but never rewrite them.

## curl

```bash
# Today's tip
curl -i http://localhost:3000/v1/tips/today

# Locale (falls back to zh-HK when a mock file is missing)
curl -i -H 'Accept-Language: zh-HK' http://localhost:3000/v1/tips/today

# ETag → 304
ETAG=$(curl -sI http://localhost:3000/v1/tips/today | awk -F': ' 'tolower($1)=="etag"{gsub("\r","",$2); print $2}')
curl -i -H "If-None-Match: $ETAG" http://localhost:3000/v1/tips/today

# Profile (no birth_vault)
curl -i http://localhost:3000/v1/me

# Chat
curl -i -X POST http://localhost:3000/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"今日做咩","tip_id":"tip_2026-09-09_zh-HK","locale":"zh-HK"}'

# Missing tip_id/message → 400
curl -i -X POST http://localhost:3000/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{}'

# Force offline so the client uses reply_pack
curl -i -X POST http://localhost:3000/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'X-Force-Offline: 1' \
  -d '{"message":"今日做咩","tip_id":"tip_2026-09-09_zh-HK","locale":"zh-HK"}'

# Reply pack
curl -i http://localhost:3000/v1/reply-packs/current
```

## Privacy

- `birth_vault` is server-only — never on client schemas or `/v1/me`
- LLM does tone/chat only; the tip pipeline owns conclusions
