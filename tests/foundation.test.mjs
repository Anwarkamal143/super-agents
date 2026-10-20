import test from "node:test";
import assert from "node:assert/strict";
import { FACTORY_NAME, FACTORY_VERSION, MINIMUM_NODE_MAJOR } from "../src/index.ts";

test("exports stable factory metadata", () => {
  assert.equal(FACTORY_NAME, "super-agents");
  assert.equal(FACTORY_VERSION, "0.1.0");
  assert.equal(MINIMUM_NODE_MAJOR, 22);
});

test("runs on the supported Node.js major version", () => {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  assert.ok(major >= MINIMUM_NODE_MAJOR, `Expected Node.js >= ${MINIMUM_NODE_MAJOR}, got ${process.versions.node}`);
});
