"use strict";

// Ordinary actions retain their budget. Planning uses the 300-second host window.
const REQUEST_MS = 110000;
const SAVE_MS = 10000;
const PLANNING_REQUEST_MS = 270000;
const PLANNING_MODEL_MS = 200000;
function start(options = {}, duration = REQUEST_MS) {
  return { ...options, deadlineAt: options.deadlineAt || Date.now() + duration };
}
function forAction(options = {}, action) {
  return start(options, action === 'plan' ? PLANNING_REQUEST_MS : REQUEST_MS);
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
module.exports = { start, forAction, timeout, signal, expired, isTimeout, REQUEST_MS, SAVE_MS, PLANNING_REQUEST_MS, PLANNING_MODEL_MS };
