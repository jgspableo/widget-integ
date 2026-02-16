/* eslint-disable no-console */

/**
 * UEF integration script:
 * - Connects to Ultra via integration:hello to get a MessagePort
 * - Authorizes using a Learn 3LO access_token
 * - Registers an "auxiliary" help provider (question-mark menu entry)
 * - When the user clicks the help menu item, opens a portal panel and renders widget.html
 *
 * Docs:
 * - Help provider request/response types: help:register, help:request, help:request:response
 * - Portal workflow: portal:panel -> portal:panel:response -> portal:render
 */

(function () {
  const LOG_PREFIX = "[UEF]";

  // --- storage keys ---
  const ACCESS_KEY = "uef_user_token";
  const REFRESH_KEY = "uef_refresh_token";
  const EXPIRES_AT_KEY = "uef_token_expires_at";
  const LEARN_HOST_KEY = "UEF_LEARN_HOST";

  // --- integration constants ---
  const HELP_PROVIDER_ID = "noodlefactory-help";
  const HELP_PROVIDER_NAME = "Noodle Factory";
  const HELP_PROVIDER_ICON_PATH = "/nf-help-icon.png"; // put this file in /public
  const PANEL_CORRELATION_ID = "noodlefactory-help-panel";

  // --- state ---
  let channel = null;
  let portalId = null;
  let lastAuthorizeAttemptAt = 0;

  // ---------- helpers ----------
  function now() {
    return Date.now();
  }

  function origin() {
    return window.location.origin;
  }

  function getLearnHostOrigin() {
    // Prefer boot-provided learn host; fallback to "*" if we must
    const fromStorage = localStorage.getItem(LEARN_HOST_KEY);
    if (fromStorage) return new URL(fromStorage).origin;
    return "*";
  }

  function getAccessToken() {
    // boot sets window.__token; keep that as highest priority
    const bootToken = window.__token;
    if (bootToken) return bootToken;

    return localStorage.getItem(ACCESS_KEY) || "";
  }

  function setAccessToken(token, expiresInSeconds) {
    if (!token) return;
    localStorage.setItem(ACCESS_KEY, token);

    if (typeof expiresInSeconds === "number" && expiresInSeconds > 0) {
      localStorage.setItem(
        EXPIRES_AT_KEY,
        String(now() + expiresInSeconds * 1000)
      );
    }
  }

  function getRefreshToken() {
    return localStorage.getItem(REFRESH_KEY) || "";
  }

  function setRefreshToken(token) {
    if (!token) return;
    localStorage.setItem(REFRESH_KEY, token);
  }

  function getExpiresAt() {
    const raw = localStorage.getItem(EXPIRES_AT_KEY);
    const v = Number(raw || "0");
    return Number.isFinite(v) ? v : 0;
  }

  function isTokenProbablyExpired(skewMs = 60_000) {
    const expiresAt = getExpiresAt();
    if (!expiresAt) return false; // unknown; try it
    return now() >= expiresAt - skewMs;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function post(msg) {
    if (!channel) throw new Error("MessagePort not ready.");
    channel.postMessage(msg);
  }

  function waitFor(predicate, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        channel && channel.removeEventListener("message", onMessage);
        reject(new Error("Timed out waiting for UEF message"));
      }, timeoutMs);

      function onMessage(evt) {
        try {
          const data = evt.data;
          if (predicate(data)) {
            clearTimeout(t);
            channel.removeEventListener("message", onMessage);
            resolve(data);
          }
        } catch (e) {
          // ignore
        }
      }

      channel.addEventListener("message", onMessage);
    });
  }

  async function refreshAccessTokenIfPossible() {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;

    console.log(`${LOG_PREFIX} Refreshing access token...`);

    const resp = await fetch("/oauth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.warn(`${LOG_PREFIX} Token refresh failed`, json);
      return false;
    }

    if (json.access_token)
      setAccessToken(json.access_token, Number(json.expires_in || 0));
    if (json.refresh_token) setRefreshToken(json.refresh_token);

    console.log(`${LOG_PREFIX} Token refresh success.`);
    return true;
  }

  async function authorizeWithUltra() {
    // avoid spamming authorization in tight loops if something is wrong
    if (now() - lastAuthorizeAttemptAt < 2000) await sleep(2000);
    lastAuthorizeAttemptAt = now();

    // If token is probably expired, refresh first (if possible)
    if (isTokenProbablyExpired()) {
      await refreshAccessTokenIfPossible();
    }

    let token = getAccessToken();

    if (!token) {
      // Try refreshing even without expiry info
      const refreshed = await refreshAccessTokenIfPossible();
      if (refreshed) token = getAccessToken();
    }

    if (!token) {
      console.warn(
        `${LOG_PREFIX} No access token available. Help menu entry will not register.`
      );
      return false;
    }

    // Send authorize request
    post({ type: "authorization:authorize", token });

    // Wait for either authorize success or unauthorize
    const res = await waitFor(
      (m) =>
        m?.type === "authorization:authorize" ||
        m?.type === "authorization:unauthorize",
      8000
    ).catch(() => null);

    if (!res) {
      console.warn(`${LOG_PREFIX} No authorize response received.`);
      return false;
    }

    if (res.type === "authorization:unauthorize") {
      console.warn(
        `${LOG_PREFIX} Unauthorized. Attempting token refresh & retry...`,
        res
      );

      // If token was rejected, attempt a refresh and retry once
      const refreshed = await refreshAccessTokenIfPossible();
      if (!refreshed) return false;

      const newToken = getAccessToken();
      if (!newToken) return false;

      post({ type: "authorization:authorize", token: newToken });

      const res2 = await waitFor(
        (m) =>
          m?.type === "authorization:authorize" ||
          m?.type === "authorization:unauthorize",
        8000
      ).catch(() => null);

      return Boolean(res2 && res2.type === "authorization:authorize");
    }

    return true;
  }

  async function registerHelpProvider() {
    // Help registration request
    post({
      type: "help:register",
      id: HELP_PROVIDER_ID,
      displayName: HELP_PROVIDER_NAME,
      providerType: "auxiliary",
      iconUrl: `${origin()}${HELP_PROVIDER_ICON_PATH}`,
    });

    const res = await waitFor(
      (m) => m?.type === "help:register:response",
      8000
    ).catch(() => null);
    if (!res) {
      console.warn(`${LOG_PREFIX} No help:register:response`);
      return false;
    }
    if (res.status !== "success") {
      console.warn(`${LOG_PREFIX} Help provider registration failed`, res);
      return false;
    }

    console.log(`${LOG_PREFIX} Help provider registered:`, res);
    return true;
  }

  async function openHelpPanel() {
    // If panel already exists, just re-render content (some Ultra states clear portals)
    if (portalId) {
      renderWidgetIntoPortal(portalId);
      return portalId;
    }

    // Request a new panel
    post({
      type: "portal:panel",
      correlationId: PANEL_CORRELATION_ID,
      panelType: "full",
      panelTitle: HELP_PROVIDER_NAME,
      useCustomPadding: true,
      attributes: {
        onClose: { callbackId: `${PANEL_CORRELATION_ID}-close` },
      },
    });

    const res = await waitFor(
      (m) =>
        m?.type === "portal:panel:response" &&
        m?.correlationId === PANEL_CORRELATION_ID,
      8000
    ).catch(() => null);

    if (!res || res.status !== "success" || !res.portalId) {
      console.warn(`${LOG_PREFIX} Failed to open panel`, res);
      return null;
    }

    portalId = res.portalId;
    renderWidgetIntoPortal(portalId);
    return portalId;
  }

  function renderWidgetIntoPortal(pid) {
    const widgetUrl = `${origin()}/widget.html?v=${Date.now()}`;

    post({
      type: "portal:render",
      portalId: pid,
      contents: {
        tag: "iframe",
        props: {
          src: widgetUrl,
          style: {
            width: "100%",
            height: "100%",
            border: "none",
            display: "block",
          },
          allow:
            "clipboard-read; clipboard-write; microphone; camera; fullscreen; autoplay; encrypted-media",
        },
      },
    });
  }

  // ---------- main message handler ----------
  async function onMessageFromUltra(message) {
    const data = message?.data;
    if (!data) return;

    // Help menu click -> Ultra sends event:event with eventType help:request
    if (data.type === "event:event" && data.eventType === "help:request") {
      console.log(`${LOG_PREFIX} Help request received:`, data);

      // Acknowledge the help request
      post({
        type: "help:request:response",
        correlationId: data.correlationId,
      });

      // Open the panel and render the widget
      await openHelpPanel();
      return;
    }

    // Panel close callback
    if (
      data.type === "portal:callback" &&
      data.callbackId === `${PANEL_CORRELATION_ID}-close`
    ) {
      portalId = null;
      console.log(`${LOG_PREFIX} Panel closed.`);
      return;
    }
  }

  // ---------- integration handshake ----------
  function onHandshake(evt) {
    const msg = evt?.data;
    if (
      !msg ||
      (msg.type !== "integration:hello" && msg.type !== "integration:port")
    )
      return;

    // Some Ultra builds send the channel via MessagePort in evt.ports[0]
    if (evt.ports && evt.ports[0]) {
      channel = evt.ports[0];
      console.log(
        `${LOG_PREFIX} ${msg.type} received; using provided MessagePort.`
      );
    } else {
      console.warn(
        `${LOG_PREFIX} ${msg.type} received but no MessagePort provided.`
      );
      return;
    }

    channel.start?.();
    channel.addEventListener("message", onMessageFromUltra);

    // Bootstrap auth + help registration
    void (async () => {
      try {
        const ok = await authorizeWithUltra();
        if (!ok) return;

        console.log(`${LOG_PREFIX} Authorized with UEF.`);

        // Optional: subscribe to portal:new (safe; not required for help:request)
        post({ type: "event:subscribe", subscriptions: ["portal:new"] });

        await registerHelpProvider();
      } catch (e) {
        console.error(`${LOG_PREFIX} init error`, e);
      }
    })();
  }

  // Start the handshake
  window.addEventListener("message", onHandshake, false);

  // Ultra expects a hello (origin should be Learn host)
  const learnOrigin = getLearnHostOrigin();
  window.parent.postMessage({ type: "integration:hello" }, learnOrigin);

  // Debug: show obvious token problems in console
  if (!getAccessToken()) {
    console.warn(
      `${LOG_PREFIX} No access token found yet. If you see "token invalid or expired", re-run /lti/launch to mint a fresh token.`
    );
  }
})();
