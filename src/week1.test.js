import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  OPENER_WEATHERS,
  TIME_BANDS,
  buildLocalContext,
  resolveOpenerWeather,
  resolveTimeBand,
  resolveWeatherBand,
} from "./context.js";
import { buildApp } from "./server.js";
import {
  OCCULT_DENY,
  buildSystemPrompt,
  filterAssistantReply,
  injectChatContext,
} from "./persona.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIP = {
  care_q: "今日工作係咪特別攰？",
  banter: "又話攰，通知列表仲紅晒。",
  action: "今日只做一件事：十一點前關晒通知，衝完涼就訓",
  why: "你近排為工作同屋企操心偏多，再撐只會更亂。",
};

const TIME_CASES = [
  ["2026-09-24T21:00:00Z", "morning"],
  ["2026-09-24T03:59:00Z", "morning"],
  ["2026-09-24T04:00:00Z", "afternoon"],
  ["2026-09-24T09:59:00Z", "afternoon"],
  ["2026-09-24T10:00:00Z", "evening"],
  ["2026-09-24T14:59:00Z", "evening"],
  ["2026-09-24T15:00:00Z", "late_night"],
  ["2026-09-24T20:30:00Z", "late_night"],
];

function loadJson(rel) {
  return JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
}

function compileSchema(rel) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value) =>
      typeof value === "string" && !Number.isNaN(Date.parse(value)),
  });
  return ajv.compile(loadJson(rel));
}

function poisonedContext() {
  return {
    display_name: "阿K",
    tip: {
      ...TIP,
      year: 1987,
      month: 3,
      day: 17,
      hour: 4,
      birth_vault: { year: 1987, chart: "RAWCHART-17" },
    },
    turns: [
      { role: "user", content: "今日做咩" },
      { role: "user", content: "幫我睇八字同運勢" },
    ],
    interests: ["work", "星座", "family"],
    time_band: "evening",
    opener_weather: "cloudy",
    weather_band: "hot",
    dial_prompt: "q2",
    birth_vault: { year: 1987, month: 3, day: 17, hour: 4 },
    year: 1987,
    month: 3,
    day: 17,
    hour: 4,
    uncertain_fields: ["hour"],
    calibration: { chart: "RAWCHART-17" },
  };
}

async function withApp(run, options = {}) {
  const app = await buildApp({ logger: false, env: {}, ...options });
  await app.ready();
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

test("output filter rewrites occult replies and keeps a safe action line", () => {
  const samples = [
    "你今日運勢好好",
    "八字話你適合休息",
    "紫微同風水都話你要改運",
    "Your natal chart says rest",
    "Check your horoscope",
    "This is occult advice",
    "feng shui is off",
  ];
  for (const sample of samples) {
    const out = filterAssistantReply(sample, TIP);
    assert.equal(out.finish_reason, "filtered", sample);
    assert.equal(OCCULT_DENY.test(out.reply), false, out.reply);
    assert.match(out.reply, /十一點前關晒通知/);
  }

  const safe = filterAssistantReply("得，收工。聽日再傾。", TIP);
  assert.equal(safe.finish_reason, "stop");
  assert.equal(safe.reply, "得，收工。聽日再傾。");
});

test("persona prompt and context injector never contain birth fields", () => {
  const poisoned = poisonedContext();
  const ctx = injectChatContext(poisoned);
  assert.deepEqual(Object.keys(ctx).sort(), [
    "dial_prompt",
    "display_name",
    "interests",
    "opener_weather",
    "time_band",
    "tip",
    "turns",
    "weather_band",
  ]);
  assert.deepEqual(Object.keys(ctx.tip).sort(), [
    "action",
    "banter",
    "care_q",
    "why",
  ]);
  assert.equal("birth_vault" in ctx, false);
  assert.equal("year" in ctx, false);
  assert.equal("hour" in ctx.tip, false);
  assert.deepEqual(ctx.interests, ["work", "family"]);
  assert.equal(ctx.turns[1].content, "");
  assert.equal(OCCULT_DENY.test(JSON.stringify(ctx)), false);
  assert.equal(ctx.dial_prompt, "q2");
  assert.equal(ctx.time_band, "evening");
  assert.equal(ctx.opener_weather, "cloudy");
  assert.equal(ctx.weather_band, "hot");

  const validate = compileSchema("schemas/chat_prompt_context.schema.json");
  assert.equal(validate(ctx), true, JSON.stringify(validate.errors));

  const prompt = buildSystemPrompt(poisoned);
  assert.equal(prompt.includes("1987"), false);
  assert.equal(prompt.includes("birth_vault"), false);
  assert.equal(prompt.includes("uncertain_fields"), false);
  assert.equal(prompt.includes("RAWCHART-17"), false);
  assert.match(prompt, /阿K/);
  assert.match(prompt, /十一點前關晒通知/);
  assert.match(prompt, /evening（夜晚）/);
  assert.match(prompt, /開場天氣：cloudy/);
  assert.match(prompt, /服裝天氣：hot/);
  assert.match(prompt, /q2/);
  assert.equal(OCCULT_DENY.test(prompt), false);
});

test("local context bands stay separate and follow Hong Kong clock", () => {
  for (const [iso, band] of TIME_CASES) {
    assert.equal(
      resolveTimeBand(new Date(iso), "Asia/Hong_Kong"),
      band,
      iso,
    );
  }

  assert.equal(resolveWeatherBand({ city: "heatwave" }), "hot");
  assert.equal(resolveOpenerWeather({ city: "heatwave" }), "extreme");
  assert.equal(resolveWeatherBand({ city: "cloudy" }), "hot");
  assert.equal(resolveOpenerWeather({ city: "cloudy" }), "cloudy");
  assert.equal(resolveWeatherBand({ city: "clear Seoul" }), "cool");
  assert.equal(resolveOpenerWeather({ city: "clear Seoul" }), "clear");
  assert.equal(resolveWeatherBand({ city: "London" }), "rain");
  assert.equal(resolveOpenerWeather({ city: "London" }), "rain");

  const hotExtreme = buildLocalContext({ city: "heatwave" }, "zh-HK", {
    now: new Date("2026-09-24T12:00:00Z"),
  });
  assert.equal(hotExtreme.weather_band, "hot");
  assert.equal(hotExtreme.opener_weather, "extreme");
  assert.equal(hotExtreme.time_band, "evening");
  assert.notEqual(hotExtreme.opener_weather, hotExtreme.weather_band);

  const validate = compileSchema("schemas/local_context.schema.json");
  assert.equal(validate(hotExtreme), true, JSON.stringify(validate.errors));
  assert.equal("fortune" in hotExtreme, false);
  assert.equal("birth_vault" in hotExtreme, false);
  assert.equal(TIME_BANDS.length, 4);
  assert.equal(OPENER_WEATHERS.includes(hotExtreme.weather_band), false);
});

test("GET /v1/context/local returns the three bands", async () => {
  await withApp(
    async (app) => {
      const hk = await app.inject({ url: "/v1/context/local" });
      assert.equal(hk.statusCode, 200);
      const body = hk.json();
      assert.equal(body.time_band, "late_night");
      assert.equal(body.opener_weather, "clear");
      assert.equal(body.weather_band, "hot");
      assert.equal("birth_vault" in body, false);

      const extreme = await app.inject({
        url: "/v1/context/local?city=heatwave",
      });
      assert.equal(extreme.json().opener_weather, "extreme");
      assert.equal(extreme.json().weather_band, "hot");

      const cool = await app.inject({
        url: "/v1/context/local?city=Seoul",
      });
      assert.equal(cool.json().weather_band, "cool");
      assert.equal(cool.json().opener_weather, "clear");
    },
    { now: () => new Date("2026-09-24T16:30:00Z") },
  );
});

test("reply pack schema validates seeds, including zh-HK openers and variants", () => {
  const validate = compileSchema("schemas/reply_pack.schema.json");
  const locales = ["zh-HK", "zh-CN", "en"];
  for (const locale of locales) {
    const pack = loadJson(`mocks/reply_pack.${locale}.json`);
    assert.equal(validate(pack), true, `${locale} ${JSON.stringify(validate.errors)}`);
    const pairs = new Set(
      pack.openers.map((row) => `${row.time_band}|${row.opener_weather}`),
    );
    assert.equal(pairs.size, 16, locale);
    for (const time of TIME_BANDS) {
      for (const weather of OPENER_WEATHERS) {
        assert.equal(pairs.has(`${time}|${weather}`), true, `${locale} ${time} ${weather}`);
      }
    }
    for (const entry of pack.entries) {
      assert.equal(entry.reply, entry.variants[0]);
      for (const line of entry.variants) {
        assert.equal(OCCULT_DENY.test(line), false, line);
      }
    }
    for (const opener of pack.openers) {
      for (const line of opener.variants) {
        assert.equal(OCCULT_DENY.test(line), false, line);
      }
    }
  }

  const zh = loadJson("mocks/reply_pack.zh-HK.json");
  const intents = ["care", "faq_what", "faq_why", "faq_busy", "faq_offline", "encourage"];
  for (const intent of intents) {
    const entry = zh.entries.find((row) => row.intent === intent);
    assert.ok(entry, intent);
    assert.ok(entry.variants.length >= 3, intent);
  }
  for (const opener of zh.openers) {
    assert.ok(opener.variants.length >= 3, `${opener.time_band} ${opener.opener_weather}`);
  }

  const broken = structuredClone(zh);
  broken.openers[0].opener_weather = "hot";
  assert.equal(validate(broken), false);
});

test("GET /v1/reply-packs/current keeps ETag and locale fallback", async () => {
  await withApp(async (app) => {
    const first = await app.inject({ url: "/v1/reply-packs/current" });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().locale, "zh-HK");
    assert.equal(first.json().openers.length, 16);
    const etag = first.headers.etag;
    assert.equal(typeof etag, "string");

    const cached = await app.inject({
      url: "/v1/reply-packs/current",
      headers: { "if-none-match": etag },
    });
    assert.equal(cached.statusCode, 304);

    const en = await app.inject({
      url: "/v1/reply-packs/current",
      headers: { "accept-language": "en" },
    });
    assert.equal(en.statusCode, 200);
    assert.equal(en.json().locale, "en");
  });
});

test("POST /v1/chat stays on the mock path without an API key", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        message: "今日做咩",
        tip_id: "tip_2026-09-09_zh-HK",
        locale: "zh-HK",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.provider, "mock");
    assert.equal(body.finish_reason, "stop");
    assert.equal(body.model_tier, "haiku");
    assert.match(body.reply, /十一點前關晒通知/);
    assert.equal(OCCULT_DENY.test(body.reply), false);
    assert.equal("birth_vault" in body, false);

    const offline = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-force-offline": "1" },
      payload: {
        message: "今日做咩",
        tip_id: "tip_2026-09-09_zh-HK",
        locale: "zh-HK",
      },
    });
    assert.equal(offline.statusCode, 503);
    assert.equal(offline.json().provider, "offline_hint");
  });
});

test("cloud chat injects safe context only and filters occult output", async () => {
  const captured = [];
  const fetchImpl = async (url, init) => {
    captured.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const occult = captured.length === 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "claude-haiku-4-5",
        content: [
          {
            type: "text",
            text: occult
              ? "你個八字今年好旺，natal chart 話你要休息"
              : "得。今晚十一點前關晒通知就收工。",
          },
        ],
      }),
    };
  };

  await withApp(
    async (app) => {
      app.saamjaiState.birth = {
        year: 1987,
        month: 3,
        day: 17,
        hour: 4,
        uncertain_fields: ["hour"],
      };
      app.saamjaiState.profile.display_name = "阿K";

      const first = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          message: "今日做咩",
          tip_id: "tip_2026-09-09_zh-HK",
          locale: "zh-HK",
        },
      });
      assert.equal(first.statusCode, 200);
      const body = first.json();
      assert.equal(body.provider, "cloud");
      assert.equal(body.finish_reason, "filtered");
      assert.equal(body.dial_prompt, null);
      assert.equal(OCCULT_DENY.test(body.reply), false);
      assert.match(body.reply, /十一點前關晒通知/);
      assert.equal(body.reply.includes("八字"), false);
      assert.equal("year" in body, false);
      assert.equal("birth_vault" in body, false);

      const call = captured[0];
      assert.match(call.url, /\/v1\/messages$/);
      assert.equal(call.headers["x-api-key"], "test-key");
      assert.equal(call.body.model, "claude-haiku-4-5");
      const blob = JSON.stringify(call.body);
      assert.equal(blob.includes("1987"), false);
      assert.equal(blob.includes("birth_vault"), false);
      assert.equal(blob.includes("uncertain_fields"), false);
      assert.equal(blob.includes("RAWCHART"), false);
      assert.match(call.body.system, /阿K/);
      assert.match(call.body.system, /evening（夜晚）/);
      assert.match(call.body.system, /開場天氣：clear/);
      assert.match(call.body.system, /服裝天氣：hot/);
      assert.equal(OCCULT_DENY.test(call.body.system), false);
      assert.equal(call.body.messages.at(-1).content, "今日做咩");

      const mem = app.saamjaiSessions.promptContext(body.session_id);
      assert.equal(
        mem.turns.some((turn) => turn.content.includes("八字")),
        false,
      );

      const second = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          message: "好",
          tip_id: "tip_2026-09-09_zh-HK",
          locale: "zh-HK",
          session_id: body.session_id,
        },
      });
      const round2 = second.json();
      assert.equal(round2.provider, "cloud");
      assert.equal(round2.finish_reason, "stop");
      assert.equal(round2.dial_prompt, "q1");
      assert.match(round2.reply, /關晒通知/);
      assert.match(captured[1].body.system, /q1/);
      assert.equal(JSON.stringify(captured[1].body).includes("1987"), false);
    },
    {
      env: { ANTHROPIC_API_KEY: "test-key" },
      fetchImpl,
      now: () => new Date("2026-09-24T12:00:00Z"),
    },
  );
});

test("occult user text is not forwarded to the cloud", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "你個八字好好" }],
      }),
    };
  };
  await withApp(
    async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          message: "幫我睇八字同運勢",
          tip_id: "tip_2026-09-09_zh-HK",
          locale: "zh-HK",
        },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(calls, 0);
      assert.equal(res.json().provider, "mock");
      assert.equal(OCCULT_DENY.test(res.json().reply), false);
      assert.match(res.json().reply, /十一點前關晒通知/);
    },
    { env: { ANTHROPIC_API_KEY: "test-key" }, fetchImpl },
  );
});

test("cloud errors fall back to the deterministic mock", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: "nope" }),
  });
  await withApp(
    async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          message: "今日做咩",
          tip_id: "tip_2026-09-09_zh-HK",
          locale: "zh-HK",
        },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().provider, "mock");
      assert.match(res.json().reply, /十一點前關晒通知/);
    },
    { env: { ANTHROPIC_API_KEY: "test-key" }, fetchImpl },
  );
});
