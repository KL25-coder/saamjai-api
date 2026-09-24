/**
 * Locked persona + output filter for 三仔 chat.
 *
 * Voice: blunt-but-kind Cantonese friend. Not a psychic shop.
 * Never argue. Never invent fortune. Tip conclusions stay in action/why;
 * the model may only polish tone.
 *
 * Prompt context is a whitelist. birth_vault and raw birth/chart fields
 * are dropped even if a caller stuffs them in.
 */

import {
  OPENER_WEATHERS,
  TIME_BANDS,
  WEATHER_BANDS,
} from "./context.js";
import { MAX_SESSION_TURNS, pickTipFour } from "./session.js";

const DIAL_QIDS = new Set(["q1", "q2", "q3", "q4", "q5"]);

const TIME_LABEL = {
  morning: "朝早",
  afternoon: "晏晝",
  evening: "夜晚",
  late_night: "深夜",
};

/**
 * zh + en occult / chart jargon. A hit on assistant text is rewritten
 * to a friend reply that points at today's action.
 */
export const OCCULT_DENY =
  /運勢|運程|八字|紫微|星盤|宮位|流年|風水|占卜|算命|命盤|命理|批命|星座|生肖|塔羅|六爻|奇門|面相|手相|玄學|靈數|改運|(?:^|[^a-z])(?:horoscopes?|natal|fortunes?|zodiacs?|occult|astrology|bazi|ziwei|divination|birth\s*charts?|feng\s*shui)(?![a-z])/i;

/** Drop deny-listed text before it can be rendered into a prompt. */
export function scrubOccult(text) {
  const value = String(text ?? "");
  if (!value || OCCULT_DENY.test(value)) return "";
  return value;
}

export function injectChatContext(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const turns = Array.isArray(src.turns) ? src.turns : [];
  const displayName = scrubOccult(
    typeof src.display_name === "string" ? src.display_name.trim() : "",
  ).trim();
  const tip = pickTipFour(src.tip);
  return {
    display_name: displayName || null,
    interests: Array.isArray(src.interests)
      ? src.interests.map((item) => scrubOccult(item).trim()).filter(Boolean)
      : [],
    tip: {
      care_q: scrubOccult(tip.care_q ?? "").trim() || null,
      banter: scrubOccult(tip.banter ?? "").trim() || null,
      action: scrubOccult(tip.action).trim(),
      why: scrubOccult(tip.why).trim(),
    },
    turns: turns.slice(-MAX_SESSION_TURNS).map((turn) => ({
      role: turn?.role === "assistant" ? "assistant" : "user",
      content: scrubOccult(turn?.content),
    })),
    time_band: TIME_BANDS.includes(src.time_band) ? src.time_band : "afternoon",
    opener_weather: OPENER_WEATHERS.includes(src.opener_weather)
      ? src.opener_weather
      : "clear",
    weather_band: WEATHER_BANDS.includes(src.weather_band)
      ? src.weather_band
      : "hot",
    dial_prompt: DIAL_QIDS.has(src.dial_prompt) ? src.dial_prompt : null,
  };
}

export function buildSystemPrompt(input) {
  const ctx = injectChatContext(input);
  const name = ctx.display_name || "朋友";
  const interests = ctx.interests.length ? ctx.interests.join("、") : "未講";
  const dial = ctx.dial_prompt
    ? `今輪可以輕帶一題，只准用 key ${ctx.dial_prompt}，唔好解釋題目，唔好加其他題。`
    : "今輪唔好主動加 dial 題。";
  return [
    "你係三仔，一個直白但好心嘅廣東話朋友。",
    "唔好爭拗，唔好預測未來，唔好改今日一件事嘅結論。",
    "結論來自規則。你只可以潤色語氣。回覆短，口語。",
    "可以先關心一句，然後指向今日 action。",
    "如果用戶想問預測，就講返今日一件事，唔好跟住問。",
    `稱呼：${name}`,
    `興趣：${interests}`,
    `時段：${ctx.time_band}（${TIME_LABEL[ctx.time_band]}）`,
    `開場天氣：${ctx.opener_weather}（同服裝天氣分開，唔好混用）`,
    `服裝天氣：${ctx.weather_band}`,
    `今日 care_q：${ctx.tip.care_q ?? ""}`,
    `今日 banter：${ctx.tip.banter ?? ""}`,
    `今日 action：${ctx.tip.action}`,
    `今日 why：${ctx.tip.why}`,
    dial,
  ].join("\n");
}

export function safeFriendFallback(tip) {
  const action = String(tip?.action ?? "").trim();
  if (!action || OCCULT_DENY.test(action)) {
    return "唔講呢啲。今日一件事就夠，我哋照做，唔好岔開。";
  }
  return `唔講呢啲。今日一件事就夠：${action}`;
}

/**
 * Rewrite assistant text that hits the occult deny-list.
 * Safe text is returned unchanged.
 */
export function filterAssistantReply(text, tip) {
  const reply = String(text ?? "").trim();
  if (!reply || OCCULT_DENY.test(reply)) {
    return {
      reply: safeFriendFallback(tip),
      finish_reason: "filtered",
    };
  }
  return { reply, finish_reason: "stop" };
}
