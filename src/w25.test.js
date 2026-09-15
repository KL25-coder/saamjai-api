import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLocalContext, resolveWeatherBand } from "./context.js";
import { applyProfilePatch, createOnboardingState } from "./onboarding.js";
import { buildApp } from "./server.js";
import {
  MAX_SESSION_TURNS,
  createSessionStore,
  memoryHasBirthRaw,
  nextDialPrompt,
  pickTipFour,
  sanitizeMemory,
} from "./session.js";

function seedState() {
  return createOnboardingState({
    user_id: "00000000-0000-4000-8000-000000000001",
    display_name: "Kev",
    locale: "zh-HK",
    familiarity_lv: 1,
    preferred_domains: ["work"],
    timezone: "Asia/Hong_Kong",
    calibration: "pending",
    onboarding_complete: false,
    updated_at: "2026-09-08T16:00:00Z",
  });
}

async function withApp(run) {
  const app = await buildApp({ logger: false });
  await app.ready();
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

test("profile patch updates display_name and interests without birth", () => {
  const state = seedState();
  state.birth = { year: 1990, month: 5, day: 12, hour: 8 };
  const profile = applyProfilePatch(state, {
    display_name: "阿K",
    interests: ["work", "family"],
  });
  assert.equal(profile.display_name, "阿K");
  assert.deepEqual(profile.interests, ["work", "family"]);
  assert.equal("year" in profile, false);
  assert.equal("birth_vault" in profile, false);
  assert.equal(state.birth.year, 1990);
});

test("session memory keeps 12 turns, tip four fields, interests — never birth", () => {
  const store = createSessionStore();
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const tip = {
    care_q: "今日攰未？",
    banter: "通知仲紅。",
    action: "十一點前關通知",
    why: "再撐會更亂",
    year: 1990,
    birth_vault: { year: 1990 },
  };

  for (let i = 0; i < 20; i += 1) {
    store.remember({
      sessionId,
      role: "user",
      content: `u${i}`,
      tip,
      interests: ["health"],
    });
    store.remember({
      sessionId,
      role: "assistant",
      content: `a${i}`,
      tip,
      interests: ["health"],
    });
  }

  const ctx = store.promptContext(sessionId);
  assert.equal(ctx.turns.length, MAX_SESSION_TURNS);
  assert.equal(ctx.turns[0].content, "u14");
  assert.deepEqual(ctx.interests, ["health"]);
  assert.deepEqual(ctx.tip, pickTipFour(tip));
  assert.equal(memoryHasBirthRaw(ctx), false);
  assert.equal("year" in ctx, false);
  assert.equal("birth_vault" in ctx, false);
  assert.equal("year" in ctx.tip, false);
});

test("sanitizeMemory strips birth_vault even if a caller stuffed it in", () => {
  const cleaned = sanitizeMemory({
    session_id: "sid",
    birth_vault: { year: 1990, month: 5, day: 12 },
    year: 1990,
    turns: [{ role: "user", content: "hi" }],
    tip: { action: "a", why: "w", hour: 8 },
    interests: ["work"],
  });
  assert.equal(memoryHasBirthRaw(cleaned), false);
  assert.deepEqual(cleaned.tip, {
    care_q: null,
    banter: null,
    action: "a",
    why: "w",
  });
});

test("dial prompts spread across later rounds, one qid at a time", () => {
  assert.equal(nextDialPrompt({ userTurnCount: 1 }), null);
  assert.equal(
    nextDialPrompt({ answeredQids: [], userTurnCount: 2 }),
    "q1",
  );
  assert.equal(
    nextDialPrompt({
      answeredQids: ["q1"],
      userTurnCount: 3,
    }),
    null,
  );
  assert.equal(
    nextDialPrompt({
      answeredQids: ["q1"],
      userTurnCount: 4,
    }),
    "q2",
  );
  assert.equal(
    nextDialPrompt({
      answeredQids: ["q1", "q2", "q3", "q4", "q5"],
      userTurnCount: 10,
    }),
    null,
  );
});

test("local context is clothing-only (hot/cool/rain), never fortune", () => {
  assert.equal(resolveWeatherBand({ city: "Hong Kong" }), "hot");
  assert.equal(resolveWeatherBand({ city: "London" }), "rain");
  assert.equal(resolveWeatherBand({ city: "Seoul" }), "cool");
  assert.equal(resolveWeatherBand({ lat: 51.5, lon: -0.1 }), "cool");

  const payload = buildLocalContext({ city: "Hong Kong" }, "zh-HK");
  assert.equal(payload.weather_band, "hot");
  assert.equal(typeof payload.summary, "string");
  assert.equal(typeof payload.updated_at, "string");
  assert.deepEqual(Object.keys(payload).sort(), [
    "summary",
    "updated_at",
    "weather_band",
  ]);
  assert.equal("fortune" in payload, false);
  assert.equal("luck" in payload, false);
  assert.equal("birth_vault" in payload, false);
});

test("GET /v1/me still omits birth after W2 birth write", async () => {
  await withApp(async (app) => {
    const birth = await app.inject({
      method: "POST",
      url: "/v1/onboarding/birth",
      payload: { year: 1990, month: 5, day: 12, hour: 8 },
    });
    assert.equal(birth.statusCode, 200);
    const receipt = birth.json();
    assert.equal(receipt.received, true);
    assert.equal("year" in receipt, false);

    const me = await app.inject({ method: "GET", url: "/v1/me" });
    assert.equal(me.statusCode, 200);
    const profile = me.json();
    assert.equal("year" in profile, false);
    assert.equal("month" in profile, false);
    assert.equal("day" in profile, false);
    assert.equal("hour" in profile, false);
    assert.equal("birth_vault" in profile, false);
  });
});

test("PATCH /v1/me and POST /v1/onboarding/profile return public profile", async () => {
  await withApp(async (app) => {
    const patched = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      payload: { display_name: "阿K", interests: ["health", "work"] },
    });
    assert.equal(patched.statusCode, 200);
    const body = patched.json();
    assert.equal(body.display_name, "阿K");
    assert.deepEqual(body.interests, ["health", "work"]);
    assert.equal("birth_vault" in body, false);

    const aliased = await app.inject({
      method: "POST",
      url: "/v1/onboarding/profile",
      payload: { interests: ["family"] },
    });
    assert.equal(aliased.statusCode, 200);
    assert.deepEqual(aliased.json().interests, ["family"]);
    assert.equal(aliased.json().display_name, "阿K");
  });
});

test("GET /v1/context/local is mockable and clothing-only", async () => {
  await withApp(async (app) => {
    const hk = await app.inject({ url: "/v1/context/local" });
    assert.equal(hk.statusCode, 200);
    const payload = hk.json();
    assert.equal(payload.weather_band, "hot");
    assert.equal("fortune" in payload, false);

    const rain = await app.inject({
      url: "/v1/context/local?city=London",
    });
    assert.equal(rain.json().weather_band, "rain");

    const coords = await app.inject({
      url: "/v1/context/local?lat=22.3&lon=114.2",
    });
    assert.equal(coords.statusCode, 200);
    assert.equal(coords.json().weather_band, "hot");

    const bad = await app.inject({ url: "/v1/context/local?lat=22.3" });
    assert.equal(bad.statusCode, 400);
  });
});

test("POST /v1/chat without history still works and issues session_id", async () => {
  await withApp(async (app) => {
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
    assert.equal(typeof body.reply, "string");
    assert.equal(typeof body.session_id, "string");
    assert.equal(body.model_tier, "haiku");
    assert.equal(body.dial_prompt, null);
    assert.equal("birth_vault" in body, false);
    assert.equal("year" in body, false);

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
    assert.equal(round2.session_id, body.session_id);
    assert.equal(round2.dial_prompt, "q1");

    const mem = app.saamjaiSessions.promptContext(body.session_id);
    assert.equal(memoryHasBirthRaw(mem), false);
    assert.equal(mem.turns.length, 4);
  });
});

test("single-qid onboarding answers still OK", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/onboarding/answers",
      payload: { answers: [{ qid: "q1", answer: "yes" }] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });
});

test("existing W2 tip and offline-chat mocks still work", async () => {
  await withApp(async (app) => {
    const tip = await app.inject({ url: "/v1/tips/today" });
    assert.equal(tip.statusCode, 200);
    const body = tip.json();
    assert.equal(typeof body.action, "string");
    assert.equal(body.personalization_mode, "conservative");
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
  });
});
