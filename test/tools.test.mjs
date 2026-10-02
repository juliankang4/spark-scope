import test from "node:test";
import assert from "node:assert/strict";
import { usageMonth, fixtureState } from "../tools/fixtures.mjs";
import { validateMonth } from "../public/view-data.js";

test("the render fixtures always have a ledger row for today, on every day of a month", () => {
  for (let day = 1; day <= 31; day += 1) {
    const now = Date.UTC(2026, 9, day, 12);
    const month = validateMonth(usageMonth("2026-10", now), "2026-10");
    assert.equal(month.days.at(-1).day, `2026-10-${String(day).padStart(2, "0")}`);
    assert.ok(fixtureState(2, "serving", now).usage.today.output > 0, `day ${day}`);
  }
});
