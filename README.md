# 三仔 API — W1 stub

## Contracts
- OpenAPI: `schemas/w1-openapi.yaml`
- JSON Schema: `schemas/*.schema.json`
- Mocks: `mocks/`

## Endpoints (W1)
| Method | Path | Notes |
|--------|------|--------|
| GET | `/v1/tips/today` | ETag / 304; fields `care_q?` `banter?` `action` `why` |
| GET | `/v1/me` | No birth_vault |
| POST | `/v1/chat` | Cloud mini/Haiku; locks persona + today's tip; no fortune rewrite |
| GET | `/v1/reply-packs/current` | Offline FAQ pack |

## Privacy
- `birth_vault` server-only — never on client schemas
- LLM does tone/chat only; tip pipeline owns conclusions

## Stack (TBD this week)
Node/Fastify or Go — align with Nova before locking.
