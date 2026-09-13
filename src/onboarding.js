/**
 * In-memory W2 onboarding + calibration (mock).
 * birth_vault is never returned to the client.
 */

export const PROFILE_KEYS = [
  "user_id",
  "display_name",
  "locale",
  "familiarity_lv",
  "preferred_domains",
  "timezone",
  "calibration",
  "onboarding_complete",
  "updated_at",
];

const BIRTH_KEYS = ["year", "month", "day", "hour", "uncertain_fields"];
const FOCUS_KEYS = ["text", "chips"];

export function nowIso() {
  return new Date().toISOString();
}

export function createOnboardingState(seedProfile) {
  return {
    profile: pickKeys(seedProfile, PROFILE_KEYS),
    birth: null,
    focus: null,
    answers: [],
  };
}

export function publicProfile(state) {
  return pickKeys(state.profile, PROFILE_KEYS);
}

export function pickBirth(body) {
  return pickKeys(body ?? {}, BIRTH_KEYS);
}

export function pickFocus(body) {
  return pickKeys(body ?? {}, FOCUS_KEYS);
}

export function upsertAnswers(existing, incoming) {
  const map = new Map((existing ?? []).map((row) => [row.qid, row]));
  for (const row of incoming ?? []) {
    map.set(row.qid, { qid: row.qid, answer: row.answer });
  }
  return [...map.values()];
}

export function isPartialUncertain(birth) {
  if (!birth) return true;
  const uncertain =
    Array.isArray(birth.uncertain_fields) && birth.uncertain_fields.length > 0;
  return uncertain || isMissingYmd(birth);
}

export function personalizationMode(calibration) {
  return calibration === "matched" ? "personalized" : "conservative";
}

export function runCalibration(state, skippedAll = false) {
  const hasBirth = state.birth != null;
  const hasAnswers = Array.isArray(state.answers) && state.answers.length > 0;

  if (skippedAll || (!hasBirth && !hasAnswers)) {
    return {
      calibration: "skipped",
      familiarity_delta: 0,
      client_message_key: "skipped",
    };
  }

  if (isPartialUncertain(state.birth)) {
    return {
      calibration: "needs_confirm",
      familiarity_delta: 0,
      client_message_key: "needs_confirm",
    };
  }

  const decisive = state.answers.filter(
    (row) => row.answer === "yes" || row.answer === "no",
  ).length;
  if (decisive >= 3) {
    return {
      calibration: "matched",
      familiarity_delta: 1,
      client_message_key: "matched",
    };
  }

  return {
    calibration: "needs_confirm",
    familiarity_delta: 0,
    client_message_key: "needs_confirm",
  };
}

function isMissingYmd(birth) {
  return birth.year == null || birth.month == null || birth.day == null;
}

function pickKeys(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source && Object.hasOwn(source, key)) out[key] = source[key];
  }
  return out;
}
