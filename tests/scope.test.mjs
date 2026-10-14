import { test } from "node:test";
import assert from "node:assert/strict";
import { createScope } from "../site/runtime/core/scope.js";

test("abort before reverse-order cleanup, once per resource", () => {
  const scope = createScope();
  const calls = [];
  scope.signal.addEventListener("abort", () => calls.push("abort"));
  const texture = { dispose() { calls.push("texture"); } };
  scope.track(texture);
  scope.track(texture);
  scope.onCleanup(() => calls.push("game"));
  assert.deepEqual(scope.dispose(), []);
  scope.dispose();
  assert.deepEqual(calls, ["abort", "game", "texture"]);
});
test("failed cleanup does not prevent remaining resources from being released", () => {
  const scope = createScope();
  let released = false;
  scope.onCleanup(() => { released = true; });
  scope.onCleanup(() => { throw new Error("broken game"); });
  assert.equal(scope.dispose().length, 1);
  assert.equal(released, true);
});
test("late async resources and cleanups are released after cancellation", () => {
  const scope = createScope();
  scope.dispose();
  let disposed = 0;
  const resource = { dispose() { disposed++; } };
  scope.track(resource);
  scope.track(resource);
  scope.onCleanup(() => { disposed++; });
  assert.equal(disposed, 2);
  assert.equal(scope.signal.aborted, true);
  assert.throws(() => scope.track({}));
});
