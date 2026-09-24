# 三仔 API — W2.5 mock

Privacy-first tip + chat + onboarding backend stub. Fortune/chart raw data stays server-side (`birth_vault`). Clients see product copy and calibration status only. LLM chat never alters tips.

W2.5 adds **soft onboarding** (name → intro → interests → later birth → dial Qs in chat), **server session memory** for Nova, and **local weather** for clothing. Existing W2 mocks stay valid.

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

- OpenAPI: `schemas/w2.5-openapi.yaml` (W2.5 source of truth; W2 in `schemas/w2-openapi.yaml`; W1 subset in `schemas/w1-openapi.yaml`)
- JSON Schema: `schemas/*.schema.json` (`onboarding.schema.json` for vault write / answers / calibration / profile patch; `session_memory.schema.json` is **server-only**; `local_context.schema.json` for weather)
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

## Week 1 dialogue

Persona is a blunt-but-kind Cantonese friend (not a psychic shop). Tip conclusions stay in the mock/rules copy (`care_q` / `banter` / `action` / `why`). The model only polishes tone. There is **no on-device Gemma** path.

`POST /v1/chat` calls cloud Claude Haiku (Anthropic Messages API) when `ANTHROPIC_API_KEY` is set. With no key, it keeps the deterministic mock (`buildChatReply`) so CI and local runs work offline. Every assistant reply passes an occult deny-list; a hit is rewritten to today's action with no jargon. `provider` is `cloud`, `mock`, or `offline_hint` (the existing `X-Force-Offline: 1` → 503).

The prompt whitelist is `display_name`, `interests`, the tip four fields, recent session turns, `time_band`, `opener_weather`, `weather_band`, and `dial_prompt`. `birth_vault` and raw year/month/day/hour never enter the prompt or the client response.

`GET /v1/context/local` now returns three bands. They are not aliases of each other:

| Field | Values | Use |
|-------|--------|-----|
| `time_band` | `morning` / `afternoon` / `evening` / `late_night` | 朝早／晏晝／夜晚／深夜 (05–11 / 12–17 / 18–22 / 23–04, `Asia/Hong_Kong`) |
| `opener_weather` | `clear` / `cloudy` / `rain` / `extreme` | 開場天氣帶 |
| `weather_band` | `hot` / `cool` / `rain` | 服裝用 (unchanged) |

Reply packs (`GET /v1/reply-packs/current`, still ETag / 304) add soft-ask `openers` keyed by `time_band` × `opener_weather`, plus `variants` on each intent for OfflineProvider. zh-HK is the full seed; zh-CN and en are light stubs.

### Env

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Cloud Messages API key. Unset → mock replies. |
| `ANTHROPIC_MODEL` | Default `claude-haiku-4-5`. |
| `ANTHROPIC_BASE_URL` | Default `https://api.anthropic.com`. |

## Privacy

- `birth_vault` is server-only — never on client schemas or `/v1/me`
- LLM does tone/chat only; the tip pipeline owns conclusions
- W2.5 chat memory and `/v1/context/local` also never include birth or fortune fields


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

## W2.5 soft onboarding + chat memory + local weather

Contracts: `schemas/w2.5-openapi.yaml`. Stubs are additive — W2 birth/focus/answers/complete and W1 chat without `history` still work.

### Soft onboarding order

Do **not** dump this in one screen:

1. `display_name` — `PATCH /v1/me` or `POST /v1/onboarding/profile`
2. 三仔 intro — **client only**, no API
3. `interests` — same profile patch
4. birth **later**, with client reason copy — existing `POST /v1/onboarding/birth` (receipt only)
5. five dial Qs (`q1`–`q5`) **spread across later chat rounds** — existing `POST /v1/onboarding/answers` with a **single qid** is still OK

Client may keep: `display_name`, `interests`, `calibration`. Birth is POST-only and **never returned** on `/me`, chat, tips, context, or calibration.

### Chat session memory (Nova)

- Server holds recent **max 12** turns, keyed by `session_id` (preferred) or `user_id`.
- Prompt contents = recent messages + today's tip **four fields** (`care_q`, `banter`, `action`, `why`) + `interests` only.
- **NEVER inject `birth_vault` raw (year/month/day/hour) into LLM prompts.**
- Tip conclusions still come from the **rules engine**. LLM only polishes `care_q` / `banter` / `action` / `why` **tone**.
- `POST /v1/chat` may **omit `history`**. Response may include `session_id` and `dial_prompt` (`q1`–`q5` or `null`). `dial_prompt` is a client-safe question **key** — never chart jargon.

The mock issues a `session_id` on first chat and echoes it back. After two user turns it may attach the next unanswered dial key (one per even turn), not all five at once.

### Local weather (clothing, not fortune)

`GET /v1/context/local?lat=&lon=` or `?city=` → `{ time_band, opener_weather, weather_band, summary, updated_at }`. Clothing stays `weather_band: hot|cool|rain`. Opener weather (`clear|cloudy|rain|extreme`) and `time_band` are separate. No fortune / luck / chart fields. Omit query params to get the Hong Kong hot + clear mock; `time_band` follows `Asia/Hong_Kong`.

| Method | Path | Notes |
|--------|------|--------|
| PATCH | `/v1/me` | `{ display_name?, interests?[] }` → public profile (no birth) |
| POST | `/v1/onboarding/profile` | Same body/response as PATCH `/v1/me` |
| GET | `/v1/context/local` | Clothing band only; mockable via `city` or `lat`+`lon` |
| POST | `/v1/chat` | History optional; returns `session_id` + `dial_prompt` |

```bash
# Soft onboarding — display_name then interests (not birth)
curl -s -X PATCH http://localhost:3000/v1/me \
  -H 'Content-Type: application/json' \
  -d '{"display_name":"阿K"}'

curl -s -X POST http://localhost:3000/v1/onboarding/profile \
  -H 'Content-Type: application/json' \
  -d '{"interests":["health","work"]}'

# Profile still has no birth fields
curl -s http://localhost:3000/v1/me

# Birth remains a later, write-only receipt
curl -s http://localhost:3000/v1/onboarding/birth \
  -H 'Content-Type: application/json' \
  -d '{"year":1990,"month":5,"day":12,"hour":8}'

# Single dial qid (spread across later chat rounds — not a five-Q dump)
curl -s http://localhost:3000/v1/onboarding/answers \
  -H 'Content-Type: application/json' \
  -d '{"answers":[{"qid":"q1","answer":"yes"}]}'

# Chat may omit history; server returns session_id + optional dial_prompt
curl -s -X POST http://localhost:3000/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"今日做咩","tip_id":"tip_2026-09-09_zh-HK","locale":"zh-HK"}'

# Resume the same session (omit history)
SID=<session_id from previous response>
curl -s -X POST http://localhost:3000/v1/chat \
  -H 'Content-Type: application/json' \
  -d "{\"message\":\"好\",\"tip_id\":\"tip_2026-09-09_zh-HK\",\"locale\":\"zh-HK\",\"session_id\":\"$SID\"}"

# Local clothing weather (default HK / hot)
curl -s http://localhost:3000/v1/context/local

curl -s 'http://localhost:3000/v1/context/local?city=London'

curl -s 'http://localhost:3000/v1/context/local?lat=22.3&lon=114.2'
```
