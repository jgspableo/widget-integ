/* global window */

(function () {
  const LMS_HOST = (window.__lmsHost || "").trim();
  const TOKEN = (window.__token || "").trim();

  // Change this to false once stable
  const DEBUG = true;

  // We'll store the MessagePort we get from Ultra here
  let messagePort = null;

  // Used for portal workflow demo
  const PANEL_CORRELATION_ID = "nf-widget-panel-1";
  let openedPortalId = null;

  function log(...args) {
    if (DEBUG) console.log("[UEF]", ...args);
  }

  function warn(...args) {
    console.warn("[UEF]", ...args);
  }

  function getToken() {
    // Prefer window.__token, fallback to localStorage
    if (TOKEN) return TOKEN;
    try {
      return localStorage.getItem("UEF_BEARER_TOKEN") || "";
    } catch {
      return "";
    }
  }

  function requireLmsHost() {
    if (!LMS_HOST) {
      warn("Missing window.__lmsHost. Set it in uef-boot.html.");
      return false;
    }
    return true;
  }

  // Step 1: Tell Ultra "I'm a UEF integration"
  // This is the documented handshake pattern. :contentReference[oaicite:5]{index=5}
  function sendIntegrationHello() {
    if (!requireLmsHost()) return;
    try {
      window.parent.postMessage({ type: "integration:hello" }, `${LMS_HOST}/*`);
      log("Sent integration:hello to", `${LMS_HOST}/*`);
    } catch (e) {
      warn("Failed to post integration:hello", e);
    }
  }

  // Step 2: After Ultra replies with integration:hello and a MessagePort,
  // authorize using authorization:authorize with 3LO token. :contentReference[oaicite:6]{index=6}
  function authorizeAndSubscribe() {
    if (!messagePort) return;

    const token = getToken();
    if (!token) {
      warn(
        "No 3LO bearer token available. The backend must redirect to uef-boot.html?token=..."
      );
      // We still proceed; Ultra may respond with auth failure events.
    }

    // Authorize to UEF with the user’s 3LO token
    messagePort.postMessage({
      type: "authorization:authorize",
      token,
    });
    log("Posted authorization:authorize");

    // Subscribe to portal:new so we can render into panels (documented workflow). :contentReference[oaicite:7]{index=7}
    messagePort.postMessage({
      type: "event:subscribe",
      subscriptions: ["portal:new"],
    });
    log("Subscribed to portal:new");

    // Demo behavior: open a panel immediately and render your NF widget host page into it.
    // This matches the portal workflow described in the docs. :contentReference[oaicite:8]{index=8}
    messagePort.postMessage({
      type: "portal:panel",
      correlationId: PANEL_CORRELATION_ID,
      panelType: "small",
      panelTitle: "Noodle Factory",
      attributes: {
        onClose: { callbackId: `${PANEL_CORRELATION_ID}-close` },
      },
    });
    log("Requested portal:panel");
  }

  function renderWidgetIntoPortal(portalId) {
    const integrationHost = `${window.location.protocol}//${window.location.host}`;

    messagePort.postMessage({
      type: "portal:render",
      portalId,
      contents: {
        tag: "span",
        props: {
          style: {
            display: "flex",
            height: "100%",
            width: "100%",
            flexDirection: "column",
            alignItems: "stretch",
            justifyContent: "stretch",
          },
        },
        children: [
          {
            tag: "iframe",
            props: {
              style: {
                flex: "1 1 auto",
                border: "0",
                width: "100%",
                height: "100%",
              },
              src: `${integrationHost}/widget.html`,
            },
          },
        ],
      },
    });

    log("Sent portal:render iframe ->", `${integrationHost}/widget.html`);
  }

  function onMessageFromUltra(evt) {
    const msg = evt?.data;
    if (!msg || typeof msg.type !== "string") return;

    // Panel response contains portalId in docs example. :contentReference[oaicite:9]{index=9}
    if (
      msg.type === "portal:panel:response" &&
      msg.correlationId === PANEL_CORRELATION_ID
    ) {
      if (msg.status !== "success" || !msg.portalId) {
        warn("portal:panel:response not successful:", msg);
        return;
      }
      openedPortalId = msg.portalId;
      log("portal:panel:response success. portalId =", openedPortalId);
      renderWidgetIntoPortal(openedPortalId);
      return;
    }

    // Optional: if you use attributes callbacks (onClose), Ultra sends portal:callback. :contentReference[oaicite:10]{index=10}
    if (msg.type === "portal:callback") {
      log("portal:callback:", msg);
      if (msg.callbackId === `${PANEL_CORRELATION_ID}-close`) {
        openedPortalId = null;
      }
      return;
    }

    // Many subscribed events come through as event:event (documented). :contentReference[oaicite:11]{index=11}
    if (msg.type === "event:event") {
      // Example structure varies by event type
      log("event:event received:", msg.eventType || msg.event?.type || msg);
    }
  }

  // Listen for the handshake response from Ultra.
  // Ultra will send integration:hello back with a MessagePort. :contentReference[oaicite:12]{index=12}
  window.addEventListener(
    "message",
    (incomingMessage) => {
      if (!incomingMessage?.data?.type) return;

      // Strict origin check recommended by docs. :contentReference[oaicite:13]{index=13}
      if (LMS_HOST && incomingMessage.origin !== LMS_HOST) {
        // Ignore anything not from your Learn host
        return;
      }

      if (incomingMessage.data.type === "integration:hello") {
        const port = incomingMessage.ports && incomingMessage.ports[0];
        if (!port) {
          warn("integration:hello received but no MessagePort provided");
          return;
        }

        messagePort = port;
        messagePort.onmessage = onMessageFromUltra;

        log("Handshake complete; MessagePort stored");
        authorizeAndSubscribe();
      }
    },
    false
  );

  // Kick off handshake
  sendIntegrationHello();
})();
