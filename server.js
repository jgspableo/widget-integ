import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
app.disable("x-powered-by");

// Blackboard LTI launch often posts form_urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- ENV ----------------
const TOOL_BASE_URL = (
  process.env.TOOL_BASE_URL || "https://widget-integ.onrender.com"
).trim();
const LEARN_HOST = (
  process.env.LEARN_HOST || "https://mapua-test.blackboard.com"
).trim();

// LTI validation (fill later)
const LTI_CLIENT_ID = (process.env.LTI_CLIENT_ID || "").trim();
const PLATFORM_ISSUER = (process.env.PLATFORM_ISSUER || "").trim();
const PLATFORM_JWKS_URL = (process.env.PLATFORM_JWKS_URL || "").trim();

// REST app creds (fill later)
const REST_KEY = (process.env.REST_KEY || "").trim();
const REST_SECRET = (process.env.REST_SECRET || "").trim();

// Tool JWKS (you generate + store in env)
const TOOL_PUBLIC_JWKS_JSON = (process.env.TOOL_PUBLIC_JWKS_JSON || "").trim();

// OAuth scope (default read)
const OAUTH_SCOPE = (process.env.OAUTH_SCOPE || "read").trim();

// ---------------- SECURITY HEADERS ----------------
// Allow Learn to iframe your tool pages (UEF runs in an iframe)
app.use((req, res, next) => {
  // Keep it permissive enough for Ultra but not totally open
  res.setHeader(
    "Content-Security-Policy",
    `frame-ancestors ${LEARN_HOST} https://*.blackboard.com;`
  );
  next();
});

// ---------------- STATIC ----------------
app.use(express.static(path.join(__dirname, "public"), { etag: true }));

// ---------------- ROUTES ----------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mapua-uef-widget",
    time: new Date().toISOString(),
  });
});

// Tool JWKS endpoint (for LTI 1.3 tool registration)
app.get("/.well-known/jwks.json", (req, res) => {
  if (!TOOL_PUBLIC_JWKS_JSON) {
    return res
      .status(500)
      .json({ error: "Missing TOOL_PUBLIC_JWKS_JSON env var" });
  }
  res.type("application/json").send(TOOL_PUBLIC_JWKS_JSON);
});

/**
 * LTI Launch endpoint (Ultra/UEF will hit this as part of the integration bootstrap)
 * Expects: form_post with id_token
 */
app.post("/lti/launch", async (req, res) => {
  try {
    const id_token = req.body.id_token;
    if (!id_token) return res.status(400).send("Missing id_token");

    // Basic guardrails so you immediately see what's missing in logs
    if (!PLATFORM_JWKS_URL || !PLATFORM_ISSUER || !LTI_CLIENT_ID) {
      return res
        .status(500)
        .send(
          "Missing PLATFORM_JWKS_URL / PLATFORM_ISSUER / LTI_CLIENT_ID (set env vars after registration)"
        );
    }
    if (!REST_KEY) {
      return res
        .status(500)
        .send(
          "Missing REST_KEY (set after Dev Portal + Learn REST integration)"
        );
    }

    // Verify platform signature / issuer / audience
    const JWKS = createRemoteJWKSet(new URL(PLATFORM_JWKS_URL));
    const { payload } = await jwtVerify(id_token, JWKS, {
      issuer: PLATFORM_ISSUER,
      audience: LTI_CLIENT_ID,
    });

    // one_time_session_token claim for iframe-safe auth
    // Claim key documented by Anthology. :contentReference[oaicite:14]{index=14}
    const oneTime =
      payload["https://blackboard.com/lti/claim/one_time_session_token"];

    if (!oneTime) {
      return res.status(400).send("Missing one_time_session_token LTI claim");
    }

    // Start Learn 3LO auth code flow
    // 3LO authorization endpoint documented as /learn/api/public/v1/oauth2/authorizationcode :contentReference[oaicite:15]{index=15}
    const redirectUri = `${TOOL_BASE_URL}/oauth/callback`;

    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      response_type: "code",
      client_id: REST_KEY,
      scope: OAUTH_SCOPE,
      state: makeState(),
      one_time_session_token: String(oneTime),
    });

    const authUrl = `${LEARN_HOST}/learn/api/public/v1/oauth2/authorizationcode?${params.toString()}`;
    return res.redirect(authUrl);
  } catch (err) {
    console.error("LTI launch error:", err);
    return res.status(401).send("LTI validation failed");
  }
});

/**
 * OAuth callback: Learn redirects to this with ?code=...
 * Exchange code for access token using Basic auth REST_KEY:REST_SECRET
 */
app.get("/oauth/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    if (!code) return res.status(400).send("Missing code");

    if (!REST_KEY || !REST_SECRET) {
      return res.status(500).send("Missing REST_KEY/REST_SECRET env vars");
    }

    const redirectUri = `${TOOL_BASE_URL}/oauth/callback`;

    // Token exchange endpoint: /learn/api/public/v1/oauth2/token :contentReference[oaicite:16]{index=16}
    const tokenUrl = `${LEARN_HOST}/learn/api/public/v1/oauth2/token?code=${encodeURIComponent(
      code
    )}&redirect_uri=${encodeURIComponent(redirectUri)}`;

    const basic = Buffer.from(`${REST_KEY}:${REST_SECRET}`).toString("base64");

    const r = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=authorization_code",
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error("3LO token exchange failed:", r.status, txt);
      return res.status(500).send("3LO token exchange failed");
    }

    const data = await r.json();
    const accessToken = data.access_token;
    if (!accessToken)
      return res.status(500).send("Missing access_token from Learn");

    // Redirect to boot page which loads uef.js and stores token
    return res.redirect(
      `/uef-boot.html?token=${encodeURIComponent(accessToken)}`
    );
  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.status(500).send("OAuth callback failed");
  }
});

function makeState() {
  return `st_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

// ---------------- LISTEN ----------------
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on http://0.0.0.0:${PORT}`);
  console.log("TOOL_BASE_URL =", TOOL_BASE_URL);
  console.log("LEARN_HOST =", LEARN_HOST);
});
