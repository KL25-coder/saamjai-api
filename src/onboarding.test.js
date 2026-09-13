import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOnboardingState,
  isPartialUncertain,
  personalizationMode,
  publicProfile,
  runCalibration,
  upsertAnswers,
} from "./onboarding.js";

function seed(overrides = {}) {
  const state = createOnboardingState({
    user_id: "00000000-0000-4000-8000-000000000001",
    display_name: "Kev",
    locale: "zh-HK",
    familiarity_lv: 1,
    preferred_domains: ["work"],
    timezone: "Asia/Hong_Kong",
    calibration: "pending",
    onboarding_complete: false,
    updated_at: "2026-09-08T16:00:00Z",
    year: 1990,
    month: 5,
    day: 12,
  });
  Object.assign(state, overrides);
  return state;
}

test("public profile never includes birth fields", () => {
  const profile = publicProfile(seed());
  assert.equal(profile.calibration, "pending");
  assert.equal(profile.onboarding_complete, false);
  assert.equal("year" in profile, false);
  assert.equal("month" in profile, false);
  assert.equal("day" in profile, false);
  assert.equal("hour" in profile, false);
});

test("skipped when no birth and no answers", () => {
  const result = runCalibration(seed());
  assert.equal(result.calibration, "skipped");
  assert.equal(result.client_message_key, "skipped");
  assert.equal(result.familiarity_delta, 0);
});

test("skipped_all wins even with complete birth", () => {
  const result = runCalibration(
    seed({
      birth: { year: 1990, month: 5, day: 12 },
      answers: [
        { qid: "q1", answer: "yes" },
        { qid: "q2", answer: "no" },
        { qid: "q3", answer: "yes" },
      ],
    }),
    true,
  );
  assert.equal(result.calibration, "skipped");
});

test("needs_confirm when birth is uncertain or missing y/m/d", () => {
  assert.equal(
    runCalibration(seed({ birth: { year: 1990, month: 5 } })).calibration,
    "needs_confirm",
  );
  assert.equal(
    runCalibration(
      seed({
        birth: {
          year: 1990,
          month: 5,
          day: 12,
          uncertain_fields: ["hour"],
        },
      }),
    ).calibration,
    "needs_confirm",
  );
});

test("matched when complete birth and at least 3 yes/no answers", () => {
  const result = runCalibration(
    seed({
      birth: { year: 1990, month: 5, day: 12, hour: 8 },
      answers: [
        { qid: "q1", answer: "yes" },
        { qid: "q2", answer: "no" },
        { qid: "q3", answer: "yes" },
        { qid: "q4", answer: "skip" },
      ],
    }),
  );
  assert.equal(result.calibration, "matched");
  assert.equal(result.familiarity_delta, 1);
});

test("needs_confirm when complete birth but fewer than 3 decisive answers", () => {
  const result = runCalibration(
    seed({
      birth: { year: 1990, month: 5, day: 12 },
      answers: [
        { qid: "q1", answer: "yes" },
        { qid: "q2", answer: "unsure" },
      ],
    }),
  );
  assert.equal(result.calibration, "needs_confirm");
});

test("partial_uncertain and personalization_mode helpers", () => {
  assert.equal(isPartialUncertain({ year: 1990, month: 5, day: 12 }), false);
  assert.equal(isPartialUncertain({ year: 1990, month: 5 }), true);
  assert.equal(personalizationMode("matched"), "personalized");
  assert.equal(personalizationMode("pending"), "conservative");
  assert.equal(personalizationMode("skipped"), "conservative");
  assert.equal(personalizationMode("needs_confirm"), "conservative");
});

test("answers upsert by qid", () => {
  const merged = upsertAnswers(
    [{ qid: "q1", answer: "skip" }],
    [{ qid: "q1", answer: "yes" }, { qid: "q2", answer: "no" }],
  );
  assert.deepEqual(merged, [
    { qid: "q1", answer: "yes" },
    { qid: "q2", answer: "no" },
  ]);
});
