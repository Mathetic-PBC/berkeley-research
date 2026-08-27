"use strict";

// Handing an installed CLI a Supabase session it can sync with, without asking
// a member to sign in a second time.
//
// Row security everywhere in `hc` is written against `auth.uid()`, so Postgres
// needs a Supabase user token; an `egb_` token is ours and means nothing to it.
// The member already proved who they are in the browser, so the exchange is a
// lookup rather than a login.
//
// What is deliberately NOT done here: signing a JWT ourselves. This project
// already publishes an ES256 JWKS alongside its legacy HS256 secret, and a
// hand-signed token stops being accepted the moment that migration finishes.
// GoTrue mints the session instead, and only the short-lived half of it ever
// leaves this file — a refresh token is full account access and has no
// business on a member's laptop.

const { ServiceError, serviceRequest } = require("./supabase");
const { supabaseConfig } = require("./config");

// A ceiling, not a promise: GoTrue decides the real lifetime from the
// project's JWT expiry, and the answer carries whatever it chose.
const MAX_SESSION_SECONDS = 60 * 60;

function hashedTokenFrom(link) {
  if (!link || typeof link !== "object") return "";
  const properties = link.properties && typeof link.properties === "object" ? link.properties : {};
  return String(link.hashed_token || properties.hashed_token || "");
}

// No email is sent: the admin endpoint hands the link back rather than mailing
// it, which is the whole reason this can happen without the member present.
async function mintLink(email, options = {}) {
  const link = await serviceRequest("/auth/v1/admin/generate_link", {
    ...options,
    method: "POST",
    body: { type: "magiclink", email: String(email || "") },
  });
  const hashed = hashedTokenFrom(link);
  if (!hashed) throw new ServiceError("Supabase issued no verifiable link", 502);
  return hashed;
}

// Redeemed here rather than on the member's machine, so the refresh token this
// returns dies inside this function.
async function redeemLink(hashed, options = {}) {
  const config = supabaseConfig(options.env || process.env);
  const fetchImpl = options.fetchImpl || global.fetch;
  const response = await fetchImpl(`${config.url}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: config.anonKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    // `token_hash`, not `token`: the latter is the raw-OTP path and GoTrue
    // rejects it without an accompanying address ("Only an email address or
    // phone number should be provided on verify"). What generate_link returns
    // is the hashed form.
    body: JSON.stringify({ type: "magiclink", token_hash: hashed }),
  });
  let value = {};
  try {
    value = await response.json();
  } catch (error) {
    value = {};
  }
  if (!response.ok || !value.access_token) {
    throw new ServiceError(value.error_description || value.msg || "Supabase refused the link", 502);
  }
  return value;
}

async function issueSession(user, options = {}) {
  if (!user || !user.email) {
    throw new ServiceError("This account has no address to sign in with", 409);
  }
  const config = supabaseConfig(options.env || process.env);
  const hashed = await mintLink(user.email, options);
  const session = await redeemLink(hashed, options);
  const now = Math.floor((options.now ? options.now() : Date.now()) / 1000);
  const lifetime = Math.min(Number(session.expires_in) || MAX_SESSION_SECONDS, MAX_SESSION_SECONDS);
  return {
    accessToken: String(session.access_token),
    tokenType: String(session.token_type || "bearer"),
    expiresIn: lifetime,
    expiresAt: now + lifetime,
    userId: String((session.user && session.user.id) || user.id || ""),
    email: String((session.user && session.user.email) || user.email).toLowerCase(),
    url: config.url,
    anonKey: config.anonKey,
  };
}

module.exports = {
  MAX_SESSION_SECONDS,
  hashedTokenFrom,
  issueSession,
  mintLink,
  redeemLink,
};
