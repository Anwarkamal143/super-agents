import test from "node:test";
import assert from "node:assert/strict";
import { greeting } from "../src/greeting.js";

test("greeting returns a personalized greeting", () => {
  assert.equal(greeting("Ada"), "Hello, Ada!");
});

test("greeting preserves the supplied name", () => {
  assert.equal(greeting("Grace Hopper"), "Hello, Grace Hopper!");
});
