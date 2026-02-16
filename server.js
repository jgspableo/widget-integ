import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

/**
 * This project uses:
 * - LTI launch (form_post) to get user context (optional, but convenient)
 * - Blackboard Learn 3LO OAuth2 to obtain an access_token (and optional refresh_token)
 * - UEF message channel + authorization:authorize using that access_token
 *
 * IMPORTANT:
 * - 3LO access tokens expire. If you want the integration to keep working across sessions
 *   (ex: help menu entry on login), request the "offline" scope so Learn returns a refresh_token,
 *   then use /oauth/refresh to rotate tokens without a user re-login.
 */

const app = express();

// Blackboard posts LTI launch as application/x-www-form-urlencoded (form_post)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- REQUIRED ENV VARS ----------------
   TOOL_BASE_URL = https://your-render-service.onrender.com
   LEARN_HOST    = https://your-learn-host.blackboard.com
   REST_KEY      = REST API integration key
   REST_SECRET   = REST API integration secret
   CLIENT_ID     = DevPortal Application (OAuth) Client ID (NOT the Application ID)
---------------------------------------------------- */

const TOOL_BASE_URL = (process.env.TOOL_BASE_URL || "").trim();
const LEARN_HOST = (process.env.LEARN_HOST || "").trim().replace(/\/+$/, "");
const REST_KEY = (process.env.REST_KEY || "").trim();
const REST_SECRET = (process.env.REST_SECRET || "").trim();
const CLIENT_ID = (process.env.CLIENT_ID || "").trim();

// For 3LO token refresh you MUST include "offline" in the scope.
// Example: "read offline"
const OAUTH_SCOPE = (process.env.OAUTH_SCOPE || "read offline").trim();

if (!TOOL_BASE_URL) throw new Error("Missing TOOL_BASE_URL env var");
if (!LEARN_HOST) throw new Error("Missing LEARN_HOST env var");
if (!REST_KEY || !REST_SECRET)
  throw new Error("Missing REST_KEY/REST_SECRET env vars");
if (!CLIENT_ID) throw new Error("Missing CLIENT_ID env var");

// Our OAuth redirect URI (must match what you registered in DevPortal)
const REDIRECT_URI = `${TOOL_BASE_URL}/lti/callback`;

// Serve static files from /public (uef-boot.html, uef.js, widget.html, nf-help-icon.png, etc.)
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

/* ============================================================================
   Helpers
============================================================================ */

function basicAuthHeader() {
  return (
    "Basic " + Buffer.from(`${REST_KEY}:${REST_SECRET}`).toString("base64")
  );
}

function randomState() {
  return crypto.randomBytes(16).toString("hex");
}

async function exchangeTokenWithLearn({ code }) {
  const tokenUrl = new URL(`${LEARN_HOST}/learn/api/public/v1/oauth2/token`);
  tokenUrl.searchParams.set("code", code);
  tokenUrl.searchParams.set("redirect_uri", REDIRECT_URI);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
  }).toString();

  const resp = await fetch(tokenUrl.toString(), {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg =
      json?.error_description ||
      json?.error ||
      resp.statusText ||
      "Token exchange failed";
    const err = new Error(msg);
    err.details = json;
    err.status = resp.status;
    throw err;
  }
  return json;
}

async function refreshTokenWithLearn({ refresh_token }) {
  const tokenUrl = new URL(`${LEARN_HOST}/learn/api/public/v1/oauth2/token`);
  tokenUrl.searchParams.set("refresh_token", refresh_token);
  tokenUrl.searchParams.set("redirect_uri", REDIRECT_URI);

  // Some Learn instances accept refresh without a grant_type body, but providing it is safest.
  const body = new URLSearchParams({ grant_type: "refresh_token" }).toString();

  const resp = await fetch(tokenUrl.toString(), {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg =
      json?.error_description ||
      json?.error ||
      resp.statusText ||
      "Token refresh failed";
    const err = new Error(msg);
    err.details = json;
    err.status = resp.status;
    throw err;
  }
  return json;
}

/* ============================================================================
   Routes
============================================================================ */

// Quick health check
app.get("/", (_req, res) => res.send("UEF widget integration server running."));

/**
 * LTI launch entry-point.
 * This route mainly exists to kick off 3LO OAuth2 so we have a Learn access_token.
 */
app.post("/lti/launch", (req, res) => {
  // Start 3LO flow:
  const state = randomState();

  const authUrl = new URL(
    `${LEARN_HOST}/learn/api/public/v1/oauth2/authorizationcode`
  );
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("scope", OAUTH_SCOPE);
  authUrl.searchParams.set("state", state);

  return res.redirect(authUrl.toString());
});

/**
 * OAuth redirect/callback from Learn.
 * Exchanges authorization code for access_token (and refresh_token if "offline" scope granted),
 * then redirects to uef-boot.html which loads uef.js.
 */
app.get("/lti/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Missing OAuth code in callback.");

    const tokenRes = await exchangeTokenWithLearn({ code: String(code) });

    const access_token = tokenRes.access_token;
    const refresh_token = tokenRes.refresh_token || "";
    const expires_in = tokenRes.expires_in || "";

    // Redirect to boot with the token(s)
    const bootUrl = new URL(`${TOOL_BASE_URL}/uef-boot.html`);
    bootUrl.searchParams.set("token", access_token);
    if (refresh_token) bootUrl.searchParams.set("refresh_token", refresh_token);
    if (expires_in) bootUrl.searchParams.set("expires_in", String(expires_in));
    bootUrl.searchParams.set("learn", LEARN_HOST);

    return res.redirect(bootUrl.toString());
  } catch (err) {
    console.error("OAuth callback error:", err?.message, err?.details || "");
    return res
      .status(500)
      .send(`OAuth callback failed: ${err?.message || "unknown error"}`);
  }
});

/**
 * Token refresh endpoint (called by public/uef.js).
 * This keeps your help menu integration alive when the access_token expires.
 */
app.post("/oauth/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) {
      return res.status(400).json({ error: "missing_refresh_token" });
    }

    const tokenRes = await refreshTokenWithLearn({
      refresh_token: String(refresh_token),
    });
    // tokenRes may include a rotated refresh_token (depends on Learn settings)
    return res.json(tokenRes);
  } catch (err) {
    console.error("Refresh error:", err?.message, err?.details || "");
    return res.status(err?.status || 500).json({
      error: "refresh_failed",
      error_description: err?.message || "unknown error",
      details: err?.details || undefined,
    });
  }
});

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  console.log(`Serving public/ at ${TOOL_BASE_URL}`);
});
