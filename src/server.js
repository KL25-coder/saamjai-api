import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { buildLocalContext, parseCoord } from "./context.js";
import { resolveChatReply, resolveLlmConfig } from "./llm.js";
import { filterAssistantReply, injectChatContext } from "./persona.js";
import {
  applyProfilePatch,
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
import {
  answeredQids,
  createSessionStore,
  nextDialPrompt,
} from "./session.js";

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

const profilePatchSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    display_name: { type: "string", minLength: 1, maxLength: 40 },
    interests: {
      type: "array",
      maxItems: 12,
      items: { type: "string", maxLength: 40 },
    },
  },
};

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

export async function buildApp(options = {}) {
  const seedProfile = options.seedProfile ?? loadSeedProfile();
  const state = createOnboardingState(seedProfile);
  const sessions = createSessionStore();
  const llm = resolveLlmConfig(options.env ?? process.env);
  const fetchImpl = options.fetchImpl;
  const clock = typeof options.now === "function" ? options.now : () => new Date();

  function localContextFor(query, locale) {
    return buildLocalContext(query, locale, {
      now: clock(),
      timeZone: state.profile.timezone || "Asia/Hong_Kong",
    });
  }

  const app = Fastify({
    logger: options.logger ?? true,
  });

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
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

  async function patchProfile(request, reply) {
    const profile = applyProfilePatch(state, request.body);
    return reply.send(profile);
  }

  app.patch("/v1/me", { schema: { body: profilePatchSchema } }, patchProfile);
  app.post(
    "/v1/onboarding/profile",
    { schema: { body: profilePatchSchema } },
    patchProfile,
  );

  app.get("/v1/context/local", async (request, reply) => {
    const query = request.query ?? {};
    const lat = parseCoord(query.lat);
    const lon = parseCoord(query.lon);
    const city = query.city;
    const latSet = query.lat != null && query.lat !== "";
    const lonSet = query.lon != null && query.lon !== "";
    if (latSet !== lonSet || Number.isNaN(lat) || Number.isNaN(lon)) {
      return reply.code(400).send({
        error: "bad_request",
        message: "lat and lon must be provided together as numbers",
      });
    }
    const locale = resolveLocale(request.headers["accept-language"]);
    return reply.send(localContextFor({ lat, lon, city }, locale));
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
            session_id: { type: "string" },
            user_id: { type: "string" },
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
          provider: "offline_hint",
        });
      }

      const { message, locale, session_id: rawSessionId, user_id: userId } =
        request.body;
      const sessionId = rawSessionId || randomUUID();
      const tipLocale = SUPPORTED_LOCALES.includes(locale)
        ? locale
        : DEFAULT_LOCALE;
      const tip = loadTip(tipLocale);
      const interests = state.profile.interests ?? [];

      // Session memory: recent turns + tip four fields + interests.
      // birth_vault is never passed into prompt context.
      sessions.remember({
        sessionId,
        userId,
        role: "user",
        content: message,
        tip,
        interests,
      });

      const dial_prompt = nextDialPrompt({
        answeredQids: answeredQids(state.answers),
        userTurnCount: sessions.userTurnCount(sessionId, userId),
      });
      if (dial_prompt) {
        sessions.markDialPrompt(sessionId, userId, dial_prompt);
      }

      const memory = sessions.promptContext(sessionId, userId);
      const bands = localContextFor({}, tipLocale);
      // Whitelist only. state.birth / calibration chart must not be copied in.
      const chatContext = injectChatContext({
        display_name: state.profile.display_name,
        interests: memory.interests,
        tip: memory.tip,
        turns: memory.turns,
        time_band: bands.time_band,
        opener_weather: bands.opener_weather,
        weather_band: bands.weather_band,
        dial_prompt,
      });

      const resolved = await resolveChatReply({
        message,
        tip,
        context: chatContext,
        llm,
        fetchImpl,
      });
      if (resolved.error) {
        request.log.warn(
          { err: resolved.error },
          "cloud llm unavailable; mock reply",
        );
      }
      const filtered = filterAssistantReply(resolved.text, tip);

      sessions.remember({
        sessionId,
        userId,
        role: "assistant",
        content: filtered.reply,
        tip,
        interests,
      });

      return reply.send({
        reply: filtered.reply,
        tip_id: tip.id,
        model_tier: "haiku",
        finish_reason: filtered.finish_reason,
        provider: resolved.provider,
        session_id: sessionId,
        dial_prompt,
        updated_at: clock().toISOString(),
      });
    },
  );

  app.get("/v1/reply-packs/current", async (request, reply) => {
    const locale = resolveLocale(request.headers["accept-language"]);
    const pack = loadReplyPack(locale);
    return sendCachedJson(request, reply, pack);
  });

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

  app.decorate("saamjaiState", state);
  app.decorate("saamjaiSessions", sessions);
  return app;
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    const app = await buildApp();
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`三仔 W2.5 mock listening on http://${HOST}:${PORT}/v1`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
