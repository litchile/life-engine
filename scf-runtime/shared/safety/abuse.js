// Per-user rate limiting and escalating jailbreak back-off, persisted in the
// scoped store so limits survive across serverless invocations. State is keyed
// by user so a group chat's abusers are tracked independently.
import { resolveSafetyPolicy } from "./policy.js";

function sanitizeUser(userId) {
  return String(userId || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96) || "anonymous";
}

function rateKey(userId) {
  return `safety/rate/${sanitizeUser(userId)}.json`;
}

async function readState(store, key) {
  if (!store || typeof store.getJson !== "function") return {};
  try {
    const value = await store.getJson(key, null);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function writeState(store, key, value) {
  if (!store || typeof store.putJson !== "function") return;
  try {
    await store.putJson(key, value);
  } catch {
    // best-effort: a storage hiccup must not crash request handling
  }
}

/**
 * Enforce the per-user request rate limit and any active back-off. Records are
 * updated on every call so the sliding window and back-off persist durably.
 * @returns {{ allowed:boolean, reason?:string, retryAfterMs?:number }}
 */
export async function enforceRateLimit(store, userId, { policy, now = Date.now() } = {}) {
  const activePolicy = policy || resolveSafetyPolicy();
  const limit = activePolicy.rateLimit || {};
  const windowMs = Number(limit.windowMs) || 60_000;
  const maxRequests = Number(limit.maxRequests) || 20;
  const key = rateKey(userId);
  const state = await readState(store, key);

  // Active back-off (e.g. from repeated jailbreak strikes) gates first.
  if (state.next_allowed_at && now < state.next_allowed_at) {
    return { allowed: false, reason: "rate_limited", retryAfterMs: state.next_allowed_at - now };
  }

  let windowStart = Number(state.window_start) || now;
  let count = Number(state.count) || 0;
  if (now - windowStart >= windowMs) {
    windowStart = now;
    count = 0;
  }
  count += 1;

  const overLimit = count > maxRequests;
  const nextState = {
    ...state,
    window_start: windowStart,
    count,
    next_allowed_at: overLimit ? now + windowMs : (state.next_allowed_at || 0),
    updated_at: new Date(now).toISOString(),
  };
  await writeState(store, key, nextState);

  return overLimit
    ? { allowed: false, reason: "rate_limited", retryAfterMs: windowMs }
    : { allowed: true };
}

/**
 * Register a jailbreak/blocked-content strike and apply escalating back-off.
 * @returns {{ strikes:number, backoffMs:number, next_allowed_at:number }}
 */
export async function registerStrike(store, userId, { policy, now = Date.now() } = {}) {
  const activePolicy = policy || resolveSafetyPolicy();
  const limit = activePolicy.rateLimit || {};
  const strikeWindowMs = Number(limit.jailbreakWindowMs) || 600_000;
  const tiers = Array.isArray(limit.jailbreakBackoffMs) && limit.jailbreakBackoffMs.length
    ? limit.jailbreakBackoffMs
    : [0];
  const key = rateKey(userId);
  const state = await readState(store, key);

  let strikeStart = Number(state.strike_window_start) || now;
  let strikes = Number(state.strikes) || 0;
  if (now - strikeStart >= strikeWindowMs) {
    strikeStart = now;
    strikes = 0;
  }
  strikes += 1;

  const tier = Math.min(strikes - 1, tiers.length - 1);
  const backoffMs = Number(tiers[tier]) || 0;
  const nextAllowedAt = Math.max(Number(state.next_allowed_at) || 0, now + backoffMs);

  const nextState = {
    ...state,
    strike_window_start: strikeStart,
    strikes,
    next_allowed_at: nextAllowedAt,
    updated_at: new Date(now).toISOString(),
  };
  await writeState(store, key, nextState);

  return { strikes, backoffMs, next_allowed_at: nextAllowedAt };
}
