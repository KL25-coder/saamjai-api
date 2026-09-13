import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { buildChatReply } from "./chat.js";
import {
  createOnboardingState,
  isPartialUncertain,
  nowIso,
  personalizationMode,
  pickBirth,
  pickFocus,
  publicProfile,
  runCalibration,
  upsertAnswers,
} from "./onboarding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MOCKS = path.join(ROOT, "mocks");

const DEFAULT_LOCALE = "zh-HK";
const SUPPORTED_LOCALES = ["zh-HK", "zh-CN", "en"];

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function resolveLocale(acceptLanguage, fallback = DEFAULT_LOCALE) {
  if (!acceptLanguage) return fallback;
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tagRaw, ...params] = part.trim().split(";");
      const tag = tagRaw.trim();
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      return { tag, q: Number.isFinite(q) ? q : 0 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const exact = SUPPORTED_LOCALES.find(
      (loc) => loc.toLowerCase() === tag.toLowerCase(),
    );
    if (exact) return exact;
    if (tag.toLowerCase() === "zh") return "zh-HK";
  }
  return fallback;
}

function mockPath(basename, locale) {
  const preferred = path.join(MOCKS, `${basename}.${locale}.json`);
  if (existsSync(preferred)) return preferred;
  return path.join(MOCKS, `${basename}.${DEFAULT_LOCALE}.json`);
}

function loadTip(locale) {
  return readJson(mockPath("tips_today", locale));
}

function loadReplyPack(locale) {
  return readJson(mockPath("reply_pack", locale));
}

function loadSeedProfile() {
  return readJson(path.join(MOCKS, "me.json"));
}

const state = createOnboardingState(loadSeedProfile());

function strongEtag(payload) {
  const hash = createHash("sha1")
    .update(JSON.stringify(payload))
    .digest("hex");
  return `"${hash}"`;
}

function ifNoneMatchHits(header, etag) {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((token) => token.trim() === etag);
}

function sendCachedJson(request, reply, payload, extraHeaders = {}) {
  const etag = strongEtag(payload);
  if (ifNoneMatchHits(request.headers["if-none-match"], etag)) {
    return reply.code(304).header("ETag", etag).send();
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    reply.header(name, value);
  }
  return reply.header("ETag", etag).send(payload);
}

const app = Fastify({
  logger: true,
});

await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Accept",
    "Accept-Language",
    "If-None-Match",
    "X-Force-Offline",
  ],
  exposedHeaders: ["ETag", "Cache-Control"],
  credentials: true,
  maxAge: 86400,
});

app.setErrorHandler((err, request, reply) => {
  if (err.validation || err.statusCode === 400) {
    const isChat = String(request.url ?? "").includes("/chat");
    return reply.code(400).send({
      error: "bad_request",
      message: isChat
        ? "tip_id and message are required"
        : (err.message ?? "invalid request"),
    });
  }
  request.log.error(err);
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  return reply.code(status).send({
    error: status === 500 ? "internal" : "error",
    message: status === 500 ? "internal error" : err.message,
  });
});

app.get("/v1/tips/today", async (request, reply) => {
  const locale = resolveLocale(request.headers["accept-language"]);
  const tip = loadTip(locale);
  tip.personalization_mode = personalizationMode(state.profile.calibration);
  return sendCachedJson(request, reply, tip, {
    "Cache-Control": "private, max-age=300",
  });
});

app.get("/v1/me", async (request, reply) => {
  return sendCachedJson(request, reply, publicProfile(state));
});

app.post(
  "/v1/chat",
  {
    schema: {
      body: {
        type: "object",
        required: ["message", "tip_id"],
        properties: {
          message: { type: "string", minLength: 1, maxLength: 2000 },
          tip_id: { type: "string", minLength: 1 },
          locale: { type: "string", enum: SUPPORTED_LOCALES },
          client_message_id: { type: "string" },
          history: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              required: ["role", "content"],
              properties: {
                role: { type: "string", enum: ["user", "assistant"] },
                content: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
  async (request, reply) => {
    if (request.headers["x-force-offline"] === "1") {
      return reply.code(503).send({
        error: "unavailable",
        message:
          "Offline / upstream unavailable — client should use reply_pack",
      });
    }

    const { message, locale } = request.body;
    const tipLocale = SUPPORTED_LOCALES.includes(locale)
      ? locale
      : DEFAULT_LOCALE;
    const tip = loadTip(tipLocale);
    const replyText = buildChatReply(message, tip);

    return reply.send({
      reply: replyText,
      tip_id: tip.id,
      model_tier: "haiku",
      finish_reason: "stop",
      updated_at: new Date().toISOString(),
    });
  },
);

app.get("/v1/reply-packs/current", async (request, reply) => {
  const locale = resolveLocale(request.headers["accept-language"]);
  const pack = loadReplyPack(locale);
  return sendCachedJson(request, reply, pack);
});

const birthWriteSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    year: { type: ["integer", "null"] },
    month: { type: ["integer", "null"], minimum: 1, maximum: 12 },
    day: { type: ["integer", "null"], minimum: 1, maximum: 31 },
    hour: { type: ["integer", "null"], minimum: 0, maximum: 23 },
    uncertain_fields: {
      type: "array",
      items: { type: "string", enum: ["year", "month", "day", "hour"] },
    },
  },
};

const focusThingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: ["string", "null"], maxLength: 200 },
    chips: {
      type: "array",
      items: {
        type: "string",
        enum: ["health", "study", "work", "romance", "family"],
      },
    },
  },
};

const onboardingAnswersSchema = {
  type: "object",
  required: ["answers"],
  additionalProperties: false,
  properties: {
    answers: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        required: ["qid", "answer"],
        additionalProperties: false,
        properties: {
          qid: { type: "string", enum: ["q1", "q2", "q3", "q4", "q5"] },
          answer: { type: "string", enum: ["yes", "no", "unsure", "skip"] },
        },
      },
    },
  },
};

app.post(
  "/v1/onboarding/birth",
  { schema: { body: birthWriteSchema } },
  async (request, reply) => {
    const birth = pickBirth(request.body);
    state.birth = birth;
    const updated_at = nowIso();
    state.profile.updated_at = updated_at;
    // Receipt only — never echo year/month/day/hour.
    return reply.send({
      received: true,
      partial_uncertain: isPartialUncertain(birth),
      updated_at,
    });
  },
);

app.post(
  "/v1/onboarding/focus",
  { schema: { body: focusThingSchema } },
  async (request, reply) => {
    state.focus = pickFocus(request.body);
    const updated_at = nowIso();
    state.profile.updated_at = updated_at;
    return reply.send({ ok: true, updated_at });
  },
);

app.post(
  "/v1/onboarding/answers",
  { schema: { body: onboardingAnswersSchema } },
  async (request, reply) => {
    state.answers = upsertAnswers(state.answers, request.body.answers);
    const updated_at = nowIso();
    state.profile.updated_at = updated_at;
    return reply.send({ ok: true, updated_at });
  },
);

app.post(
  "/v1/onboarding/complete",
  {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          skipped_all: { type: "boolean" },
        },
      },
    },
    preValidation: async (request) => {
      if (request.body == null) request.body = {};
    },
  },
  async (request, reply) => {
    const skippedAll = Boolean(request.body?.skipped_all);
    const result = runCalibration(state, skippedAll);
    const updated_at = nowIso();
    state.profile.calibration = result.calibration;
    state.profile.onboarding_complete = true;
    state.profile.updated_at = updated_at;
    return reply.send({
      calibration: result.calibration,
      familiarity_delta: result.familiarity_delta,
      client_message_key: result.client_message_key,
      updated_at,
    });
  },
);

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`三仔 W2 mock listening on http://${HOST}:${PORT}/v1`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
