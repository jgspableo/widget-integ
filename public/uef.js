/* global window */

(function () {
  const LMS_HOST = (window.__lmsHost || "").trim();
  const TOKEN = (window.__token || "").trim();

  const DEBUG = true;

  // Help menu entry (question mark menu)
  const HELP_PROVIDER_ID = "nf-widget-help";
  const HELP_PROVIDER_NAME = "NF Widget";
  const HELP_PROVIDER_TYPE = "auxiliary"; // shows as an extra item in Help menu

  // Optional: set to an ABSOLUTE URL if you want an icon in the Help menu item
  // Example: `${window.location.origin}/nf-help-icon.png`
  const HELP_ICON_URL = "";

  // UEF MessagePort from Ultra
  let messagePort = null;

  // Authorization + setup state
  let isAuthorized = false;
  let didPostSubscriptions = false;
  let didRegisterHelpProvider = false;

  // Portal/panel state
  let openedPortalId = null;
  let openingPanel = false;
  let panelCorrelationId = null;

  function log(...args) {
    if (DEBUG) console.log("[UEF]", ...args);
  }

  function warn(...args) {
    console.warn("[UEF]", ...args);
  }

  // Persist token for later navigations (optional but helps stability)
  try {
    if (TOKEN) localStorage.setItem("UEF_BEARER_TOKEN", TOKEN);
  } catch {
    // ignore
  }

  function getToken() {
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

  // Step 1: handshake
  function sendIntegrationHello() {
    if (!requireLmsHost()) return;
    try {
      // IMPORTANT: targetOrigin should be the origin only (no /*)
      window.parent.postMessage({ type: "integration:hello" }, LMS_HOST);
      log("Sent integration:hello to", LMS_HOST);
    } catch (e) {
      warn("Failed to post integration:hello", e);
    }
  }

  function postAuthorize() {
    if (!messagePort) return;

    const token = getToken();
    if (!token) {
      warn(
        "No 3LO bearer token available. Provide ?token=... to uef-boot.html or persist it in localStorage."
      );
    }

    messagePort.postMessage({
      type: "authorization:authorize",
      token,
    });
    log("Posted authorization:authorize");
  }

  function postSubscriptionsIfNeeded() {
    if (!messagePort || didPostSubscriptions) return;

    // Subscribe only after auth succeeds to reduce “not authenticated” warnings
    messagePort.postMessage({
      type: "event:subscribe",
      subscriptions: ["portal:new"],
    });

    didPostSubscriptions = true;
    log("Subscribed to portal:new");
  }

  function registerHelpProviderIfNeeded() {
    if (!messagePort || !isAuthorized || didRegisterHelpProvider) return;

    const payload = {
      type: "help:register",
      id: HELP_PROVIDER_ID,
      displayName: HELP_PROVIDER_NAME,
      providerType: HELP_PROVIDER_TYPE,
    };

    if (HELP_ICON_URL) payload.iconUrl = HELP_ICON_URL;

    messagePort.postMessage(payload);
    didRegisterHelpProvider = true;
    log("Registered Help menu entry:", HELP_PROVIDER_NAME);
  }

  function renderWidgetIntoPortal(portalId) {
    if (!messagePort) return;
    const integrationHost = window.location.origin;

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

  function openPanel() {
    if (!messagePort) return;
    if (!isAuthorized) {
      warn("Tried to open panel before authorization finished.");
      return;
    }

    // If already open, just re-render (or you can no-op)
    if (openedPortalId) {
      renderWidgetIntoPortal(openedPortalId);
      return;
    }

    if (openingPanel) return;
    openingPanel = true;

    panelCorrelationId = `nf-widget-panel-${Date.now()}`;

    messagePort.postMessage({
      type: "portal:panel",
      correlationId: panelCorrelationId,
      panelType: "small",
      panelTitle: HELP_PROVIDER_NAME,
      attributes: {
        onClose: { callbackId: `${panelCorrelationId}-close` },
      },
    });

    log("Requested portal:panel", panelCorrelationId);
  }

  function ackHelpRequest(correlationId) {
    if (!messagePort || !correlationId) return;
    messagePort.postMessage({
      type: "help:request:response",
      correlationId,
    });
  }

  function onMessageFromUltra(evt) {
    const msg = evt?.data;
    if (!msg || typeof msg.type !== "string") return;

    // Authorization response
    if (msg.type === "authorization:authorize:response") {
      const ok =
        msg.status === "success" ||
        msg.success === true ||
        msg.authorized === true;

      if (ok) {
        isAuthorized = true;
        log("Authorize OK ✅");
        postSubscriptionsIfNeeded();
        registerHelpProviderIfNeeded();
      } else {
        warn("Authorize failed:", msg);
      }
      return;
    }

    // Help menu click -> Ultra sends help:request as an event
    if (msg.type === "event:event" && msg.eventType === "help:request") {
      // Only react if it’s OUR help provider entry (objectId should match our id)
      if (msg.objectId && msg.objectId !== HELP_PROVIDER_ID) return;

      log("Help requested:", msg);

      // ACK the request (required correlation)
      ackHelpRequest(msg.correlationId);

      // Open the widget panel when clicked
      openPanel();
      return;
    }

    // Panel response -> gives portalId
    if (
      msg.type === "portal:panel:response" &&
      msg.correlationId === panelCorrelationId
    ) {
      openingPanel = false;

      if (msg.status !== "success" || !msg.portalId) {
        warn("portal:panel:response not successful:", msg);
        return;
      }

      openedPortalId = msg.portalId;
      log("portal:panel success. portalId =", openedPortalId);
      renderWidgetIntoPortal(openedPortalId);
      return;
    }

    // Close callbacks
    if (msg.type === "portal:callback") {
      log("portal:callback:", msg);
      if (
        typeof msg.callbackId === "string" &&
        msg.callbackId.endsWith("-close")
      ) {
        openedPortalId = null;
        openingPanel = false;
      }
      return;
    }

    // Other events (optional logging)
    if (msg.type === "event:event") {
      log("event:event received:", msg.eventType || msg.event || msg);
    }
  }

  // Receive the handshake response (MessagePort)
  window.addEventListener(
    "message",
    (incomingMessage) => {
      if (!incomingMessage?.data?.type) return;

      // Strict origin check
      if (LMS_HOST && incomingMessage.origin !== LMS_HOST) return;

      if (incomingMessage.data.type === "integration:hello") {
        const port = incomingMessage.ports && incomingMessage.ports[0];
        if (!port) {
          warn("integration:hello received but no MessagePort provided");
          return;
        }

        messagePort = port;
        messagePort.onmessage = onMessageFromUltra;

        log("Handshake complete; MessagePort stored");
        postAuthorize();
      }
    },
    false
  );

  // Kick off handshake
  sendIntegrationHello();
})();
