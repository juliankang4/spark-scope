import { test } from "node:test";
import assert from "node:assert/strict";

test("deliberate failure to prove the CI gate blocks a red PR", () => {
  assert.equal(1, 2);
});
