/**
 * W2.5 in-memory chat session store (mock).
 *
 * Memory for LLM prompts = recent messages + today's tip four fields + interests.
 * NEVER inject birth_vault (year/month/day/hour) into prompt context.
 */

export const MAX_SESSION_TURNS = 12;
export const DIAL_QIDS = ["q1", "q2", "q3", "q4", "q5"];
export const TIP_FOUR_FIELDS = ["care_q", "banter", "action", "why"];
export const BIRTH_RAW_KEYS = [
  "birth_vault",
  "year",
  "month",
  "day",
  "hour",
  "uncertain_fields",
];

export function pickTipFour(tip) {
  return {
    care_q: tip?.care_q ?? null,
    banter: tip?.banter ?? null,
    action: tip?.action ?? "",
    why: tip?.why ?? "",
  };
}

export function answeredQids(answers) {
  return (answers ?? [])
    .filter((row) => row && DIAL_QIDS.includes(row.qid))
    .map((row) => row.qid);
}

/**
 * Spread five dial Qs across later chat rounds — at most one key per even
 * user turn after the first companion exchange. Never dumps q1–q5 together.
 * Returns a client-safe qid or null (never question copy / chart jargon).
 */
export function nextDialPrompt({
  answeredQids: done = [],
  userTurnCount = 0,
} = {}) {
  if (userTurnCount < 2) return null;
  if (userTurnCount % 2 !== 0) return null;
  const unanswered = DIAL_QIDS.filter((qid) => !done.includes(qid));
  return unanswered[0] ?? null;
}

export function memoryKey({ sessionId, userId } = {}) {
  if (sessionId) return `session:${sessionId}`;
  if (userId) return `user:${userId}`;
  return null;
}

export function createSessionStore() {
  const sessions = new Map();

  function load(key) {
    return (
      sessions.get(key) ?? {
        sessionId: null,
        userId: null,
        turns: [],
        tip: pickTipFour(null),
        interests: [],
        lastPromptedQid: null,
      }
    );
  }

  function promptContext(sessionId, userId) {
    const key = memoryKey({ sessionId, userId });
    if (!key) {
      return {
        session_id: sessionId ?? null,
        user_id: userId ?? null,
        turns: [],
        tip: pickTipFour(null),
        interests: [],
      };
    }
    const row = load(key);
    return sanitizeMemory({
      session_id: row.sessionId ?? sessionId ?? null,
      user_id: row.userId ?? userId ?? null,
      turns: row.turns.slice(-MAX_SESSION_TURNS),
      tip: pickTipFour(row.tip),
      interests: [...(row.interests ?? [])],
    });
  }

  function remember({
    sessionId,
    userId,
    role,
    content,
    tip,
    interests,
  }) {
    const key = memoryKey({ sessionId, userId });
    if (!key) {
      return promptContext(sessionId, userId);
    }
    const row = load(key);
    row.sessionId = sessionId ?? row.sessionId;
    row.userId = userId ?? row.userId;
    if (tip) row.tip = pickTipFour(tip);
    if (Array.isArray(interests)) row.interests = interests.map(String);
    row.turns = [
      ...row.turns,
      { role, content: String(content ?? "") },
    ].slice(-MAX_SESSION_TURNS);
    sessions.set(key, row);
    return promptContext(sessionId, userId);
  }

  function markDialPrompt(sessionId, userId, qid) {
    const key = memoryKey({ sessionId, userId });
    if (!key) return;
    const row = load(key);
    row.lastPromptedQid = qid;
    row.sessionId = sessionId ?? row.sessionId;
    row.userId = userId ?? row.userId;
    sessions.set(key, row);
  }

  function userTurnCount(sessionId, userId) {
    const ctx = promptContext(sessionId, userId);
    return ctx.turns.filter((turn) => turn.role === "user").length;
  }

  function lastPromptedQid(sessionId, userId) {
    const key = memoryKey({ sessionId, userId });
    if (!key) return null;
    return load(key).lastPromptedQid ?? null;
  }

  return {
    promptContext,
    remember,
    markDialPrompt,
    userTurnCount,
    lastPromptedQid,
  };
}

export function sanitizeMemory(memory) {
  const turns = (memory.turns ?? [])
    .slice(-MAX_SESSION_TURNS)
    .map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: String(turn.content ?? ""),
    }));
  const out = {
    turns,
    tip: pickTipFour(memory.tip),
    interests: Array.isArray(memory.interests)
      ? memory.interests.map(String)
      : [],
  };
  if (memory.session_id) out.session_id = memory.session_id;
  if (memory.user_id) out.user_id = memory.user_id;
  for (const key of BIRTH_RAW_KEYS) {
    delete out[key];
    if (out.tip) delete out.tip[key];
  }
  return out;
}

export function memoryHasBirthRaw(memory) {
  if (!memory || typeof memory !== "object") return false;
  if (BIRTH_RAW_KEYS.some((key) => Object.hasOwn(memory, key))) return true;
  if (memory.tip && BIRTH_RAW_KEYS.some((key) => Object.hasOwn(memory.tip, key))) {
    return true;
  }
  const blob = JSON.stringify(memory);
  return /"birth_vault"/.test(blob);
}
