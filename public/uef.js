// public/uef.js
(() => {
  const LOG_PREFIX = "[UEF]";

  // If your boot page sets window.__lmsHost, we’ll use it; otherwise fall back to your test host.
  const LMS_HOST = (
    window.__lmsHost || "https://mapua-test.blackboard.com"
  ).replace(/\/+$/, "");
  const integrationHost = `${location.protocol}//${location.host}`;

  // Help Provider config
  // NOTE: "auxiliary" makes it a menu entry under the (?) Help menu.
  const HELP_PROVIDER_ID = (
    window.__helpProviderId || "noodlefactory-help"
  ).trim();
  const HELP_DISPLAY_NAME = "Noodle Factory";
  const HELP_PROVIDER_TYPE = "auxiliary";
  // Host an icon from your own /public (add the file). Keep it HTTPS-accessible.
  const HELP_ICON_URL = `${integrationHost}/nf-help-icon.png`;

  // Panel + widget config
  const PANEL_PATH = "/widget.html";
  const PANEL_CORRELATION_ID = "nf-widget-panel";
  const PANEL_TITLE = "Noodle Factory Help";
  const PANEL_TYPE = "small"; // "small" | "medium" | "large"

  let messageChannel = null;
  let authorized = false;

  let portalId = null;
  let widgetRendered = false;

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function err(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  function createMessageChannel(url) {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();

    channel.port1.onmessage = (event) => {
      onMessageFromUltra(event);
    };

    // Give Ultra the other port so it can talk to us
    window.parent.postMessage(
      { type: "integration:port", port: channel.port2 },
      LMS_HOST,
      [channel.port2]
    );

    return channel.port1;
  }

  function postHello() {
    // This is how your existing integration starts the handshake.
    window.parent.postMessage({ type: "integration:hello" }, `${LMS_HOST}/*`);
  }

  function getBearerToken() {
    // Prefer token from boot
    if (window.__token && typeof window.__token === "string")
      return window.__token;

    // Fall back to localStorage keys (your repo used two different keys; support both)
    const t1 = localStorage.getItem("uef_user_token");
    if (t1) return t1;
    const t2 = localStorage.getItem("UEF_BEARER_TOKEN");
    if (t2) return t2;

    return "";
  }

  function authorizeWithUltra() {
    const token = getBearerToken();
    if (!token) {
      warn("Missing bearer token; cannot authorize.");
      return;
    }

    messageChannel.postMessage({
      type: "authorization:authorize",
      token,
    });
  }

  function registerHelpProvider() {
    if (!messageChannel || !authorized) return;

    messageChannel.postMessage({
      type: "help:register",
      id: HELP_PROVIDER_ID,
      displayName: HELP_DISPLAY_NAME,
      providerType: HELP_PROVIDER_TYPE, // "auxiliary"
      iconUrl: HELP_ICON_URL,
    });

    log("Sent help:register", {
      id: HELP_PROVIDER_ID,
      providerType: HELP_PROVIDER_TYPE,
    });
  }

  function openPanelIfNeeded() {
    if (!messageChannel || !authorized) return;

    // Even if already open, re-sending portal:panel is a decent "focus" attempt.
    messageChannel.postMessage({
      type: "portal:panel",
      correlationId: PANEL_CORRELATION_ID,
      panelType: PANEL_TYPE,
      panelTitle: PANEL_TITLE,
    });
  }

  function createWidgetIframeElement() {
    return {
      tag: "Iframe",
      src: `${integrationHost}${PANEL_PATH}`,
      title: PANEL_TITLE,
      width: "100%",
      height: "100%",
      scrollable: false,
    };
  }

  function renderWidget() {
    if (!messageChannel || !portalId) return;

    messageChannel.postMessage({
      type: "portal:render",
      portalId,
      contents: createWidgetIframeElement(),
    });
  }

  function handleHelpRequest(msg) {
    // msg has: correlationId, helpUrl, currentRouteName, timeout, etc.
    log("Received help:request", msg);

    // Open (or focus) the panel and render the widget
    openPanelIfNeeded();

    // IMPORTANT: Respond back using the same correlationId. :contentReference[oaicite:4]{index=4}
    messageChannel.postMessage({
      type: "help:request:response",
      correlationId: msg.correlationId,
    });
  }

  function onMessageFromUltra(event) {
    const data = event.data;

    if (!data || !data.type) return;

    // 1) Authorization response
    if (data.type === "authorization:authorize") {
      authorized = true;
      log("Authorized with UEF.");

      // Register the Help menu entry (auxiliary provider). :contentReference[oaicite:5]{index=5}
      registerHelpProvider();
      return;
    }

    if (data.type === "authorization:unauthorize") {
      authorized = false;
      warn("Unauthorized by UEF.", data);
      return;
    }

    // 2) Help provider registration response (same type "help:register", status field). :contentReference[oaicite:6]{index=6}
    if (data.type === "help:register") {
      log("Help provider register response:", data);
      return;
    }

    // 3) Help menu click request arrives as an event occurrence with eventType help:request. :contentReference[oaicite:7]{index=7}
    if (data.type === "event:event" && data.eventType === "help:request") {
      handleHelpRequest(data);
      return;
    }

    // 4) Panel open response gives us portalId (your original code uses this)
    if (data.type === "portal:panel:response") {
      if (data.correlationId === PANEL_CORRELATION_ID && data.portalId) {
        portalId = data.portalId;
        log("Panel opened, portalId =", portalId);

        // Render once per portal open
        if (!widgetRendered) {
          renderWidget();
        }
      }
      return;
    }

    // 5) Render response
    if (data.type === "portal:render:response") {
      if (data.portalId === portalId) {
        widgetRendered = true;
        log("Widget rendered into portal.");
      }
      return;
    }
  }

  // Listen for the initial handshake reply
  window.addEventListener("message", (event) => {
    const data = event.data;

    if (!data || data.type !== "integration:hello") return;

    // Create the message channel back to Ultra
    log("integration:hello received; creating message channel.");
    messageChannel = createMessageChannel(data.url);

    // Authorize (this will then register help provider)
    authorizeWithUltra();
  });

  // Start handshake
  postHello();
})();
