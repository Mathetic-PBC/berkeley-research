"use strict";

// Vercel allows 120 seconds. Stop work early enough to persist a useful reply.
const REQUEST_MS = 110000;
const SAVE_MS = 10000;
function start(options = {}) {
  return { ...options, deadlineAt: options.deadlineAt || Date.now() + REQUEST_MS };
}
function timeout(options = {}, cap = 90000, reserve = SAVE_MS) {
  const remaining = options.deadlineAt ? options.deadlineAt - Date.now() - reserve : cap;
  if (remaining <= 0) throw expired();
  return Math.max(1, Math.min(cap, remaining));
}
function signal(options = {}, cap, reserve) {
  const timer = AbortSignal.timeout(timeout(options, cap, reserve));
  return options.signal ? AbortSignal.any([options.signal, timer]) : timer;
}
function expired() {
  return Object.assign(new Error("This step timed out. Retry to continue from the last saved step."), { statusCode: 504, code: "STEP_TIMEOUT" });
}
function isTimeout(error) { return error && ["TimeoutError", "AbortError"].includes(error.name) || error?.code === "STEP_TIMEOUT"; }
module.exports = { start, timeout, signal, expired, isTimeout, REQUEST_MS, SAVE_MS };
