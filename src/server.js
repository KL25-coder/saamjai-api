import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { buildChatReply } from "./chat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MOCKS = path.join(ROOT, "mocks");

const DEFAULT_LOCALE = "zh-HK";
const SUPPORTED_LOCALES = ["zh-HK", "zh-CN", "en"];
const PROFILE_KEYS = [
  "user_id",
  "display_name",
  "locale",
  "familiarity_lv",
  "preferred_domains",
  "timezone",
  "updated_at",
];

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

function loadPublicProfile() {
  const raw = readJson(path.join(MOCKS, "me.json"));
  const profile = {};
  for (const key of PROFILE_KEYS) {
    if (Object.hasOwn(raw, key)) profile[key] = raw[key];
  }
  return profile;
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
    return reply.code(400).send({
      error: "bad_request",
      message: "tip_id and message are required",
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
  return sendCachedJson(request, reply, tip, {
    "Cache-Control": "private, max-age=300",
  });
});

app.get("/v1/me", async (request, reply) => {
  const profile = loadPublicProfile();
  return sendCachedJson(request, reply, profile);
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

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`三仔 W1 mock listening on http://${HOST}:${PORT}/v1`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
