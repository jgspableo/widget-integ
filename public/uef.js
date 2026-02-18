/**
 * UEF integration script (runs inside Blackboard Ultra).
 *
 * What this version does:
 * 1) Registers a Help menu entry (with icon) -> opens a right-side panel containing your widget iframe.
 * 2) Registers a Base Navigation left-rail route ("Ask Mappy").
 *    - The route page itself shows a lightweight "Opening..." placeholder (NOT the widget).
 *    - When the user navigates to that route, we open the right-side panel and render the widget iframe there.
 *
 * Key UEF references:
 * - basenav:register request (displayName, routeName, initialContents) :contentReference[oaicite:4]{index=4}
 * - route events (event:event with eventType 'route') :contentReference[oaicite:5]{index=5}
 * - event subscriptions (event:subscribe) :contentReference[oaicite:6]{index=6}
 * - help:register request includes iconUrl :contentReference[oaicite:7]{index=7}
 * - portal workflow (portal:panel -> portal:render) :contentReference[oaicite:8]{index=8}
 */

/* =====================================================
   CONFIG
===================================================== */

const INTEGRATION_ID = "noodlefactory-help"; // stable id for help:register
const INTEGRATION_NAME = "Ask Mappy";
const ICON_PATH = "/nf-help-icon.png"; // must be publicly reachable from your hosting domain

// Base navigation (left rail) route
const BASE_NAV_ROUTE_NAME = "ask-mappy"; // must be stable & unique
const BASE_NAV_DISPLAY_NAME = INTEGRATION_NAME;

// Where to load your widget from (served by your tool host)
const WIDGET_PATH = "/widget.html";

// Token storage key used by your uef-boot.html
const TOKEN_STORAGE_KEY = "uef_user_token";

// Behavior toggles
const OPEN_PANEL_WHEN_BASE_NAV_ROUTE_ENTERED = true; // left nav click -> open panel
const OPEN_PANEL_WHEN_HELP_MENU_CLICKED = true; // (?) help entry -> open panel

// Panel options
const PANEL_TYPE = "small"; // "small" or "full" (depends on UEF support)
const PANEL_TITLE = INTEGRATION_NAME;

/* =====================================================
   STATE
===================================================== */

let messageChannel = null;
let isAuthorized = false;

let helpRegistered = false;
let baseNavRegistered = false;

let currentPortalId = null;
let currentPanelCorrelationId = null;
let currentCloseCallbackId = null;

// used to prevent spamming panel-open on repeated route events
let openedFromBaseNavThisVisit = false;

/* =====================================================
   UTILS
===================================================== */

function getIntegrationHost() {
  return `${window.location.protocol}//${window.location.hostname}${
    window.location.port ? `:${window.location.port}` : ""
  }`;
}

function getLmsHost() {
  // uef-boot.html typically sets window.__lmsHost
  if (typeof window.__lmsHost === "string" && window.__lmsHost.trim()) {
    return window.__lmsHost.trim();
  }

  // fallback to referrer origin if possible
  try {
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref) return ref.origin;
  } catch {}

  return "";
}

function getToken() {
  // uef-boot.html may set window.__token
  if (typeof window.__token === "string" && window.__token.trim()) {
    return window.__token.trim();
  }
  return (localStorage.getItem(TOKEN_STORAGE_KEY) || "").trim();
}

function randomId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

class LoggedMessageChannel {
  constructor(port) {
    this.port = port;
    this.port.onmessage = this.onMessage.bind(this);
  }
  onMessage(event) {
    try {
      onMessageFromUltra(event);
    } catch (e) {
      console.error("[UEF] onMessageFromUltra error:", e);
    }
  }
  postMessage(message, transfer) {
    console.log("[UEF] →", message);
    this.port.postMessage(message, transfer);
  }
}

/* =====================================================
   HANDSHAKE (integration:hello -> MessagePort)
===================================================== */

function startHandshake() {
  const lmsHost = getLmsHost();
  if (!lmsHost) {
    console.warn("[UEF] Missing LMS host (window.__lmsHost not set).");
    return;
  }

  // Send hello to Ultra to receive the MessagePort back.
  // Message channel handshake flow is documented in UEF start docs. :contentReference[oaicite:9]{index=9}
  window.parent.postMessage({ type: "integration:hello" }, `${lmsHost}/*`);
}

function onPostMessageReceived(event) {
  const lmsHost = getLmsHost();
  if (!lmsHost) return;

  // strict origin check
  if (event.origin !== lmsHost) return;

  const msg = event.data || {};
  if (!msg.type) return;

  // Ultra provides a MessagePort in event.ports[0]
  if (msg.type !== "integration:hello" && msg.type !== "integration:port") return;

  const port = event.ports && event.ports[0];
  if (!port) {
    console.warn("[UEF] Handshake received but no MessagePort found:", msg);
    return;
  }

  if (messageChannel) {
    console.log("[UEF] MessagePort already set; ignoring extra port.");
    return;
  }

  messageChannel = new LoggedMessageChannel(port);
  console.log("[UEF] Handshake complete; MessagePort acquired.");

  authorize();
}

/* =====================================================
   AUTH + SUBSCRIPTIONS
===================================================== */

function authorize() {
  const token = getToken();
  if (!token) {
    console.warn("[UEF] No user token found. Ensure /uef-boot.html ran and stored it.");
    return;
  }

  messageChannel.postMessage({
    type: "authorization:authorize",
    token,
  });
}

function subscribeToEvents() {
  if (!messageChannel || !isAuthorized) return;

  // Subscribing to route events lets us detect when user navigates to our BaseNav route. :contentReference[oaicite:10]{index=10}
  messageChannel.postMessage({
    type: "event:subscribe",
    subscriptions: ["route", "route:changing", "portal:new", "portal:remove"],
  });
}

/* =====================================================
   HELP PROVIDER + BASE NAV REGISTRATION
===================================================== */

function registerHelpProvider() {
  if (!messageChannel || !isAuthorized || helpRegistered) return;

  const integrationHost = getIntegrationHost();
  const iconUrl = `${integrationHost}${ICON_PATH}`;

  // help:register supports iconUrl and providerType. :contentReference[oaicite:11]{index=11}
  messageChannel.postMessage({
    type: "help:register",
    id: INTEGRATION_ID,
    displayName: INTEGRATION_NAME,
    providerType: "auxiliary",
    iconUrl,
  });
}

function registerBaseNavigationRoute() {
  if (!messageChannel || !isAuthorized || baseNavRegistered) return;

  // basenav:register supports displayName, routeName, initialContents (no icon field). :contentReference[oaicite:12]{index=12}
  messageChannel.postMessage({
    type: "basenav:register",
    displayName: BASE_NAV_DISPLAY_NAME,
    routeName: BASE_NAV_ROUTE_NAME,

    // IMPORTANT: Keep this lightweight.
    // We are NOT embedding the widget here anymore; we open the panel on route entry instead.
    initialContents: {
      tag: "div",
      props: {
        style: {
          padding: "16px",
          fontFamily: "inherit",
        },
      },
      children: [
        {
          tag: "h2",
          props: { style: { margin: "0 0 8px 0" } },
          children: ["Opening Ask Mappy…"],
        },
        {
          tag: "p",
          props: { style: { margin: "0", opacity: "0.8" } },
          children: ["If nothing opens, check popups/third-party blocking and refresh."],
        },
      ],
    },
  });
}

/* =====================================================
   PANEL OPEN + RENDER
===================================================== */

function renderWidgetIntoPortal(portalId) {
  const integrationHost = getIntegrationHost();
  const widgetUrl = `${integrationHost}${WIDGET_PATH}`;

  // Render an iframe into the portal using portal:render. :contentReference[oaicite:13]{index=13}
  messageChannel.postMessage({
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
            src: widgetUrl,
            style: {
              border: "0",
              height: "100%",
              width: "100%",
            },
          },
        },
      ],
    },
  });
}

function ensurePanelOpenAndRendered(reason = "unknown") {
  if (!messageChannel || !isAuthorized) return;

  // If already open, just re-render to ensure iframe is alive.
  if (currentPortalId) {
    console.log(`[UEF] Panel already open; re-rendering (reason=${reason}).`);
    renderWidgetIntoPortal(currentPortalId);
    return;
  }

  currentPanelCorrelationId = randomId("mappy-panel");
  currentCloseCallbackId = `${currentPanelCorrelationId}-close`;

  // Open a panel via portal:panel, then wait for portal:panel:response. :contentReference[oaicite:14]{index=14}
  messageChannel.postMessage({
    type: "portal:panel",
    correlationId: currentPanelCorrelationId,
    panelType: PANEL_TYPE,
    panelTitle: PANEL_TITLE,
    attributes: {
      onClose: { callbackId: currentCloseCallbackId },
    },
  });
}

/* =====================================================
   EVENT HANDLERS
===================================================== */

function handleHelpRequest(message) {
  // ACK help request fast, then open panel. :contentReference[oaicite:15]{index=15}
  const correlationId = message.correlationId;

  messageChannel.postMessage({
    type: "help:request:response",
    correlationId,
  });

  if (OPEN_PANEL_WHEN_HELP_MENU_CLICKED) {
    ensurePanelOpenAndRendered("help");
  }
}

function handleRouteEvent(message) {
  // Route event payload contains routeName. :contentReference[oaicite:16]{index=16}
  const routeName = message.routeName;

  // reset gating if user is not on our route
  if (routeName !== BASE_NAV_ROUTE_NAME) {
    openedFromBaseNavThisVisit = false;
    return;
  }

  if (!OPEN_PANEL_WHEN_BASE_NAV_ROUTE_ENTERED) return;

  // prevent repeated opens if multiple route events fire while on the same route
  if (openedFromBaseNavThisVisit) return;

  openedFromBaseNavThisVisit = true;
  ensurePanelOpenAndRendered("basenav-route");
}

/* =====================================================
   MESSAGE ROUTER (FROM ULTRA)
===================================================== */

function onMessageFromUltra(event) {
  const message = event.data || {};
  if (!message.type) return;

  console.log("[UEF] ←", message);

  // Authorization success
  if (message.type === "authorization:authorize") {
    isAuthorized = true;

    subscribeToEvents(); // includes route subscriptions :contentReference[oaicite:17]{index=17}

    registerHelpProvider();
    registerBaseNavigationRoute();
    return;
  }

  // Authorization failure
  if (message.type === "authorization:unauthorize") {
    console.error("[UEF] Unauthorized:", message.errorInformation);
    isAuthorized = false;
    helpRegistered = false;
    baseNavRegistered = false;
    return;
  }

  // Registration responses
  if (message.type === "help:register") {
    helpRegistered = message.status === "success";
    console.log(
      helpRegistered
        ? `[UEF] Help provider registered as "${INTEGRATION_NAME}".`
        : "[UEF] Help provider registration failed."
    );
    return;
  }

  if (message.type === "basenav:register") {
    baseNavRegistered = message.status === "success";
    console.log(
      baseNavRegistered
        ? `[UEF] Base nav route registered "${BASE_NAV_DISPLAY_NAME}" (routeName="${BASE_NAV_ROUTE_NAME}").`
        : "[UEF] Base nav registration failed."
    );
    return;
  }

  // Telemetry/event stream
  if (message.type === "event:event") {
    // help menu click comes as help:request events
    if (message.eventType === "help:request") {
      handleHelpRequest(message);
      return;
    }

    // route events fire when navigation completes :contentReference[oaicite:18]{index=18}
    if (message.eventType === "route") {
      handleRouteEvent(message);
      return;
    }

    return;
  }

  // Panel open response
  if (message.type === "portal:panel:response") {
    if (
      !currentPanelCorrelationId ||
      message.correlationId !== currentPanelCorrelationId
    ) {
      return;
    }

    if (message.status !== "success") {
      console.error("[UEF] portal:panel failed:", message);
      currentPortalId = null;
      return;
    }

    currentPortalId = message.portalId;
    console.log("[UEF] Panel opened. portalId =", currentPortalId);

    renderWidgetIntoPortal(currentPortalId);
    return;
  }

  // Panel close callback
  if (message.type === "portal:callback") {
    if (message.callbackId === currentCloseCallbackId) {
      console.log("[UEF] Panel closed.");
      currentPortalId = null;
      currentPanelCorrelationId = null;
      currentCloseCallbackId = null;
    }
    return;
  }

  // Render response (debugging)
  if (message.type === "portal:render:response") {
    if (message.status !== "success") {
      console.error("[UEF] portal:render failed:", message.error, message.errorMessage);
    } else {
      console.log("[UEF] portal:render success for portalId:", message.portalId);
    }
    return;
  }
}

/* =====================================================
   BOOT
===================================================== */

window.addEventListener("message", onPostMessageReceived);
startHandshake();
