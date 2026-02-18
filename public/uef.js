/**
 * UEF integration script (runs inside Blackboard Learn Ultra).
 *
 * Goal (your request):
 * - Show "Ask Mappy" in the LEFT base navigation (global rail)
 * - When user clicks it, OPEN a RIGHT-SIDE PANEL and load your widget (widget.html) in an iframe.
 * - Keep the (?) Help menu entry (with your custom icon) and make it open the same panel.
 *
 * Key UEF details:
 * - Base nav registration expects a "Link" element with a top-level `to` field (NOT props.to).
 *   See docs example for basenav:register. :contentReference[oaicite:2]{index=2}
 */

(() => {
  const CFG = {
    learnHost: window.__lmsHost || "https://mapua-test.blackboard.com",
    tokenStorageKey: "uef_user_token",
    displayName: "Ask Mappy",

    helpProviderId: "noodlefactory-help",

    // Base navigation route for left-rail entry
    baseNavRouteName: "ask-mappy",

    // Panel config
    panelType: "small",
    panelTargetPortalId: "nf-panel-root", // optional: depends on Learn/UEF version
    widgetUrlPath: "/widget.html",
    iconUrlPath: "/nf-help-icon.png",
  };

  // ----------------------------
  // State
  // ----------------------------
  let messagePort = null;

  let authed = false;

  let helpRegistered = false;
  let baseNavRegistered = false;

  let panelOpen = false;
  let panelPortalId = null;
  let panelCloseCallbackId = null;

  // ----------------------------
  // Utilities
  // ----------------------------
  const log = (...args) => console.log("[UEF]", ...args);
  const warn = (...args) => console.warn("[UEF]", ...args);
  const err = (...args) => console.error("[UEF]", ...args);

  function getIntegrationOrigin() {
    const { protocol, hostname, port } = window.location;
    return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
  }

  function getWidgetUrl() {
    return `${getIntegrationOrigin()}${CFG.widgetUrlPath}`;
  }

  function getIconUrl() {
    return `${getIntegrationOrigin()}${CFG.iconUrlPath}`;
  }

  function getToken() {
    if (typeof window.__token === "string" && window.__token.trim()) {
      return window.__token.trim();
    }

    // Primary storage key used by this script
    const v1 = (localStorage.getItem(CFG.tokenStorageKey) || "").trim();
    if (v1) return v1;

    // Compatibility with uef-boot.html (stores token under this key)
    const v2 = (localStorage.getItem("UEF_BEARER_TOKEN") || "").trim();
    return v2;
  }

  function makeCorrelationId(prefix = "id") {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function send(msg) {
    if (!messagePort) {
      warn("send() called before messagePort is ready:", msg);
      return;
    }
    messagePort.postMessage(msg);
    log("→", msg);
  }

  // ----------------------------
  // Handshake / Auth
  // ----------------------------
  function startHandshake() {
    // Note: docs have mixed examples of integration-hello vs integration:hello in different places.
    // Your current instance is clearly working with the colon version.
    window.parent.postMessage(
      { type: "integration:hello" },
      `${CFG.learnHost}/*`
    );
  }

  function authorize() {
    const token = getToken();
    if (!token) {
      warn("No OAuth token found. Did /uef-boot.html receive ?token=... ?");
      return;
    }

    send({
      type: "authorization:authorize",
      token,
    });
  }

  function subscribeEvents() {
    send({
      type: "event:subscribe",
      subscriptions: ["route", "portal:new", "portal:remove"],
    });
  }

  // ----------------------------
  // Help Provider Registration
  // ----------------------------
  function registerHelpProvider() {
    if (helpRegistered) return;

    send({
      type: "help:register",
      id: CFG.helpProviderId,
      displayName: CFG.displayName,
      providerType: "auxiliary",
      iconUrl: getIconUrl(),
    });
  }

  // ----------------------------
  // Base Nav Registration (LEFT RAIL)
  // ----------------------------
  function registerBaseNav() {
    if (baseNavRegistered) return;

    send({
      type: "basenav:register",
      displayName: CFG.displayName,
      routeName: CFG.baseNavRouteName,

      // Left-rail clickable entry
      // IMPORTANT: For tag: "Link", UEF expects `to` at the top level (not inside props).
      // If you send `{ props: { to: ... } }`, Learn will still reserve a slot in the nav
      // but render the label as blank (what you're seeing). :contentReference[oaicite:3]{index=3}
      contents: {
        tag: "Link",
        to: CFG.baseNavRouteName,
        children: CFG.displayName,
      },

      // Route page content (keep it light; panel is the real UI)
      // Note: UEF standard element children must be string OR element[] (not string[]). :contentReference[oaicite:4]{index=4}
      initialContents: {
        tag: "div",
        props: { style: { padding: "16px", fontFamily: "inherit" } },
        children: [
          {
            tag: "h2",
            props: { style: { margin: "0 0 8px 0" } },
            children: "Opening Ask Mappy…",
          },
          {
            tag: "p",
            props: { style: { margin: "0", opacity: "0.8" } },
            children:
              "If the panel did not open, refresh the page and try again.",
          },
        ],
      },
    });
  }

  // ----------------------------
  // Panel Open + Render
  // ----------------------------
  function openPanel() {
    if (panelOpen) {
      // If already open, just re-render to be safe
      if (panelPortalId) renderWidget(panelPortalId);
      return;
    }

    panelOpen = true;
    panelPortalId = null;

    panelCloseCallbackId = makeCorrelationId("panel-close");

    send({
      type: "portal:panel",
      // selector is optional/implementation-dependent; keeping what you had
      selector: "base.messages",
      panelType: CFG.panelType,
      panelTitle: CFG.displayName,
      targetPortalId: CFG.panelTargetPortalId,
      attributes: {
        onClose: { callbackId: panelCloseCallbackId },
      },
    });
  }

  function renderWidget(portalId) {
    send({
      type: "portal:render",
      portalId,
      contents: {
        tag: "div",
        props: {
          style: {
            height: "100%",
            width: "100%",
            padding: "0",
            margin: "0",
          },
        },
        children: [
          {
            tag: "iframe",
            props: {
              src: getWidgetUrl(),
              style: {
                border: "0",
                width: "100%",
                height: "100%",
              },
            },
          },
        ],
      },
    });
  }

  // ----------------------------
  // Event Handlers
  // ----------------------------
  function handleRouteEvent(msg) {
    // When user navigates to our base nav route, open the panel
    if (msg.routeName === CFG.baseNavRouteName) {
      log("Route matched Ask Mappy:", msg.routeName);
      openPanel();
    }
  }

  function handlePortalNew(msg) {
    // When the panel is created, Learn emits portal:new. We'll use the portalId to render.
    if (!panelOpen) return;

    // If Learn provides a portalId, capture it and render into it.
    if (msg.portalId && !panelPortalId) {
      panelPortalId = msg.portalId;
      log("Captured panel portalId:", panelPortalId);
      renderWidget(panelPortalId);
    }
  }

  function handlePortalRemove(msg) {
    // If our panel closes, reset state.
    if (panelPortalId && msg.portalId === panelPortalId) {
      log("Panel removed:", msg.portalId);
      panelOpen = false;
      panelPortalId = null;
      panelCloseCallbackId = null;
    }
  }

  // ----------------------------
  // Message listeners
  // ----------------------------
  function onWindowMessage(incoming) {
    // Only accept messages from Learn host
    if (!incoming || incoming.origin !== CFG.learnHost) return;

    // On initial handshake, Learn sends a MessagePort via incoming.ports[0]
    const t = incoming?.data?.type;
    if (t === "integration:hello" && incoming.ports && incoming.ports[0]) {
      messagePort = incoming.ports[0];
      messagePort.onmessage = onPortMessage;

      log("MessagePort established.");
      authorize();
    }
  }

  function onPortMessage(e) {
    const msg = e?.data;
    if (!msg || !msg.type) return;

    // The console in your screenshot is basically these objects.
    log("←", msg);

    switch (msg.type) {
      case "authorization:authorize":
        authed = true;
        subscribeEvents();
        registerHelpProvider();
        registerBaseNav();
        break;

      case "help:request":
        // Clicking the Help menu item should trigger this
        openPanel();
        break;

      case "help:register":
        if (msg.status === "success") helpRegistered = true;
        break;

      case "basenav:register":
        if (msg.status === "success") baseNavRegistered = true;
        break;

      case "event:event":
        if (msg.eventType === "route") handleRouteEvent(msg);
        if (msg.eventType === "portal:new") handlePortalNew(msg);
        if (msg.eventType === "portal:remove") handlePortalRemove(msg);
        break;

      case "portal:callback":
        // handle close callback, if emitted
        if (msg.callbackId && msg.callbackId === panelCloseCallbackId) {
          log("Panel close callback received.");
          panelOpen = false;
          panelPortalId = null;
          panelCloseCallbackId = null;
        }
        break;

      default:
        break;
    }
  }

  // ----------------------------
  // Boot
  // ----------------------------
  window.addEventListener("message", onWindowMessage);
  startHandshake();
})();
