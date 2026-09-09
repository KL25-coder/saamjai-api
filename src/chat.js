/**
 * Locked-persona mock chat for W1.
 *
 * Voice: blunt-but-kind friend. Optional care. One daily action.
 * Never argue. Never rewrite action/why. Never invent fortune / occult jargon.
 */

const OCCULT =
  /運勢|運程|八字|紫微|星盤|宮位|流年|風水|占卜|算命|fortune|horoscope|natal|occult|zodiac/i;

function includesAny(message, needles) {
  const lower = message.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

export function buildChatReply(message, tip) {
  const msg = String(message ?? "").trim();
  const action = tip.action;
  const why = tip.why;
  const care = tip.care_q;

  if (OCCULT.test(msg)) {
    return `唔講呢啲。今日一件事就夠：${action}`;
  }

  if (includesAny(msg, ["今日做咩", "一件事", "要做咩", "做咩"])) {
    return `${action}。今日只做呢一件，唔好加料。`;
  }

  if (includesAny(msg, ["點解", "為什麼", "为什麼", "為咩", "why"])) {
    return `${why} 所以先係呢一件：${action}`;
  }

  if (includesAny(msg, ["好忙", "唔得閒", "遲啲", "busy"])) {
    return `得。唔逼你而家做。記低：${action}`;
  }

  if (includesAny(msg, ["做完", "得啦"])) {
    return "得，收工。聽日再傾。";
  }

  if (/^(ok|okay)\b/i.test(msg) || msg === "OK") {
    return "得，收工。聽日再傾。";
  }

  if (care && includesAny(msg, ["點呀", "你好", "在嗎", "hi", "hey"])) {
    return `喺。${care}`;
  }

  const bits = [];
  if (care) bits.push(care);
  bits.push(`記住今日一件事：${action}`);
  bits.push(why);
  return bits.join(" ");
}
