/* public/uef.js
   UEF bootstrap script (runs inside the UEF iframe).
   - Handshake with Ultra shell
   - Authorize using token from uef-boot.html?token=...
   - Register Help menu item (auxiliary provider)
   - When user clicks Help item -> open right panel and render widget.html
*/

(() => {
  const LOG = (...a) => console.log("[UEF]", ...a);
  const WARN = (...a) => console.warn("[UEF]", ...a);
  const ERR = (...a) => console.error("[UEF]", ...a);

  // ----------------------------------------------------
  // Config (passed by uef-boot.html) + derived URLs
  // ----------------------------------------------------
  const BASE_URL = window.location.origin;
  const WIDGET_URL = `${BASE_URL}/widget.html`;

  // uef-boot.html should set this:
  // window.__UEF_LEARN_HOST = "https://mapua-test.blackboard.com";
  const LEARN_HOST = (window.__UEF_LEARN_HOST || "").trim();

  let LEARN_ORIGIN = "";
  try {
    if (LEARN_HOST) LEARN_ORIGIN = new URL(LEARN_HOST).origin;
  } catch {
    // ignore
  }

  // token passed as /uef-boot.html?token=...
  const qs = new URLSearchParams(window.location.search);
  const tokenFromUrl = (qs.get("token") || "").trim();
  if (tokenFromUrl) localStorage.setItem("UEF_USER_TOKEN", tokenFromUrl);

  const TOKEN = (
    tokenFromUrl ||
    localStorage.getItem("UEF_USER_TOKEN") ||
    ""
  ).trim();

  if (!LEARN_ORIGIN) {
    WARN(
      "Missing LEARN_ORIGIN. Ensure uef-boot.html sets window.__UEF_LEARN_HOST."
    );
    return;
  }
  if (!TOKEN) {
    WARN("Missing TOKEN. Ensure UEF loads uef-boot.html?token=...");
    return;
  }

  // ----------------------------------------------------
  // UEF Port / State
  // ----------------------------------------------------
  /** @type {MessagePort | null} */
  let port = null;

  let portalId = null;

  function post(msg) {
    if (!port) {
      WARN("No MessagePort yet; cannot post:", msg);
      return;
    }
    port.postMessage(msg);
  }

  // ----------------------------------------------------
  // Ultra message handler (MessagePort)
  // ----------------------------------------------------
  function onUltraPortMessage(evt) {
    const msg = evt?.data;
    LOG("From Ultra:", msg);

    if (!msg || typeof msg !== "object") return;

    // ✅ Authorization "success" arrives as type "authorization:authorize"
    // (failures arrive as "authorization:unauthorize")
    if (msg.type === "authorization:authorize") {
      LOG("Authorize OK ✅");

      // Register Help menu entry (auxiliary provider)
      // Note: official request fields are top-level (not nested).
      // providerType can be "primary" or "auxiliary".
      post({
        type: "help:register",
        id: "nf-widget-help",
        displayName: "NF Widget",
        providerType: "auxiliary",
        // iconUrl is optional; omit if you don't have a publicly reachable icon
        // iconUrl: `${BASE_URL}/nf-icon.png`,
      });
      LOG("Posted help:register (auxiliary)");

      // Subscribe to portal events (needed for right-side panel rendering)
      post({
        type: "event:subscribe",
        subscriptions: ["portal:new"],
      });
      LOG("Subscribed to portal:new");

      return;
    }

    if (msg.type === "authorization:unauthorize") {
      ERR("Authorize FAILED:", msg);
      WARN(
        "If you see this, the token is wrong/expired OR your UEF placement doesn't have the scopes you need."
      );
      return;
    }

    // Help menu click is delivered as event:event with eventType help:request
    if (msg.type === "event:event" && msg.eventType === "help:request") {
      LOG("help:request received ✅ — opening panel...");

      // Ask Ultra for a right-side panel portal
      post({ type: "portal:panel" });
      LOG("Requested portal:panel");

      // Acknowledge the help request (minimal response is OK)
      if (msg.correlationId) {
        post({
          type: "help:request:response",
          correlationId: msg.correlationId,
        });
        LOG("Posted help:request:response");
      }

      return;
    }

    // Panel created -> gives us a portalId to render into
    if (msg.type === "portal:panel:response") {
      if (msg.status === "success" && msg.portalId) {
        portalId = msg.portalId;
        LOG("portal:panel success, portalId =", portalId);

        // Render widget.html inside the portal as an iframe
        post({
          type: "portal:render",
          portalId,
          contents: {
            tag: "iframe",
            props: {
              src: WIDGET_URL,
              title: "NF Widget",
              style: {
                width: "100%",
                height: "100%",
                border: "0",
              },
            },
          },
        });
        LOG("Posted portal:render iframe ->", WIDGET_URL);
      } else {
        ERR("portal:panel failed:", msg);
      }
      return;
    }

    if (msg.type === "portal:render:response") {
      if (msg.status === "success") LOG("portal:render success ✅");
      else ERR("portal:render failed:", msg);
      return;
    }
  }

  // ----------------------------------------------------
  // Handshake (window.postMessage -> receive MessagePort from Ultra)
  // ----------------------------------------------------
  function onWindowMessage(evt) {
    // Only accept messages from your Learn origin
    if (evt.origin !== LEARN_ORIGIN) return;

    const msg = evt?.data;
    if (!msg || typeof msg !== "object") return;

    // Ultra responds to integration:hello with a MessagePort in evt.ports[0]
    if (msg.type === "integration:hello") {
      const p = evt.ports && evt.ports[0];
      if (!p) {
        WARN(
          "integration:hello received but no MessagePort found in evt.ports[0]"
        );
        return;
      }

      port = p;
      port.onmessage = onUltraPortMessage;
      // Some browsers require starting the port explicitly
      if (typeof port.start === "function") port.start();

      LOG("Handshake complete; MessagePort stored");

      // Now authorize
      post({ type: "authorization:authorize", token: TOKEN });
      LOG("Posted authorization:authorize");

      // Only need handshake once
      window.removeEventListener("message", onWindowMessage);
    }
  }

  window.addEventListener("message", onWindowMessage);

  // Start handshake
  window.parent.postMessage({ type: "integration:hello" }, `${LEARN_ORIGIN}/*`);
  LOG("Sent integration:hello to", `${LEARN_ORIGIN}/*`);
})();
