# 三仔 API — W2 mock

Privacy-first tip + chat + onboarding backend stub. Fortune/chart raw data stays server-side (`birth_vault`). Clients see product copy and calibration status only. LLM chat never alters tips.

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

The OpenAPI placeholder `https://api.example.local/v1` maps here. Point Flutter (including web/dev) at `http://localhost:3000/v1`. CORS is enabled for local/dev origins.

## Contracts

- OpenAPI: `schemas/w2-openapi.yaml` (W2 source of truth; W1 subset in `schemas/w1-openapi.yaml`)
- JSON Schema: `schemas/*.schema.json` (`onboarding.schema.json` for vault write / answers / calibration)
- Mocks: `mocks/` (`me.json` includes `calibration`; never includes birth fields)

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


## W2 onboarding + tip pipeline (in-memory mock)

Contracts: `schemas/w2-openapi.yaml`, `schemas/onboarding.schema.json`.

| Method | Path | Notes |
|--------|------|--------|
| POST | `/v1/onboarding/birth` | Writes `birth_vault` in memory; **receipt only** — never echoes `year`/`month`/`day`/`hour` |
| POST | `/v1/onboarding/focus` | One focus thing / chips; `{ ok, updated_at }` |
| POST | `/v1/onboarding/answers` | One or more of five dial Qs (`q1`–`q5`, `yes`/`no`/`unsure`/`skip`); `{ ok, updated_at }` |
| POST | `/v1/onboarding/complete` | Optional `{ skipped_all }`; returns `CalibrationResult` only |

State is process-memory (lost on restart). `GET /v1/me` returns `calibration` + `onboarding_complete` and never birth fields.

`GET /v1/tips/today` sets `personalization_mode`:
- `personalized` when `calibration=matched`
- `conservative` when `needs_confirm`, `pending`, or `skipped` (same tip copy in this mock)

Calibration (mock):
- `skipped_all` or no birth and no answers → `skipped` (`familiarity_delta=0`)
- birth has `uncertain_fields` or missing `year`/`month`/`day` → `needs_confirm`
- else if at least 3 answers are `yes`/`no` → `matched` (`familiarity_delta=1`)
- else → `needs_confirm`

Client must never receive birth raw fields. Rules engine owns conclusions; LLM polishes `care_q`/`banter`/`action`/`why` tone only.

```bash
# Birth vault write — receipt only (no year/month/day/hour in response)
curl -s http://localhost:3000/v1/onboarding/birth \
  -H 'Content-Type: application/json' \
  -d '{"year":1990,"month":5,"day":12,"hour":8}'

# Partial / uncertain birth
curl -s http://localhost:3000/v1/onboarding/birth \
  -H 'Content-Type: application/json' \
  -d '{"year":1990,"month":5,"day":null,"uncertain_fields":["day","hour"]}'

# Focus thing
curl -s http://localhost:3000/v1/onboarding/focus \
  -H 'Content-Type: application/json' \
  -d '{"text":"想瞓得好啲","chips":["health","work"]}'

# Dial answers
curl -s http://localhost:3000/v1/onboarding/answers \
  -H 'Content-Type: application/json' \
  -d '{"answers":[{"qid":"q1","answer":"yes"},{"qid":"q2","answer":"no"},{"qid":"q3","answer":"yes"},{"qid":"q4","answer":"skip"},{"qid":"q5","answer":"unsure"}]}'

# Complete → CalibrationResult (matched if birth is complete + ≥3 yes/no)
curl -s http://localhost:3000/v1/onboarding/complete \
  -H 'Content-Type: application/json' \
  -d '{}'

# Skip all
curl -s http://localhost:3000/v1/onboarding/complete \
  -H 'Content-Type: application/json' \
  -d '{"skipped_all":true}'

# Profile after onboarding (calibration present; no birth fields)
curl -s http://localhost:3000/v1/me

# Tip mode follows calibration (conservative unless matched)
curl -s http://localhost:3000/v1/tips/today
```
