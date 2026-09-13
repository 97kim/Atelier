import { test } from "node:test";
import assert from "node:assert/strict";
import { isThemeMode, resolveTheme } from "./theme";

test("resolveTheme: system 은 시스템을 따르고, 고정값은 그대로", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(isThemeMode("dark"), true);
  assert.equal(isThemeMode("auto"), false);
  assert.equal(isThemeMode(undefined), false);
});
