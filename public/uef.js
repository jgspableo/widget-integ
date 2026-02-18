/**
 * UEF integration script (runs inside Blackboard Learn Ultra).
 *
 * What this script does:
 * 1) UEF handshake -> obtains a MessagePort.
 * 2) Authorizes with the UEF token (set by uef-boot.html).
 * 3) Registers:
 *    - Help Provider (so "Ask Mappy" appears under the (?) menu)
 *    - Base Navigation Route (so "Ask Mappy" can appear as a left-rail item)
 * 4) When the user clicks your help entry, it opens a right-side panel and renders widget.html.
 *
 * IMPORTANT NOTE ABOUT THE LEFT NAV (global rail):
 * - UEF's `basenav:register` registers a route.
 * - To actually get a CLICKABLE entry in the rail, you must provide a Link element in `contents`
 *   (see docs example). Without `contents`, you can get a "success" response but still not
 *   see anything in the rail.
 *
 * References (official docs):
 * - IBaseNavigationRegistrationRequest example includes a `contents` Link:
 *   https://docs.blackboard.com/rest-apis/learn/uef/UEFDocs/build/docs/interfaces/ibasenavigationregistrationrequest.html
 * - ILinkElement shape (tag/props.to/children):
 *   https://docs.blackboard.com/rest-apis/learn/uef/UEFDocs/build/docs/interfaces/ilinkelement.html
 */

/* =====================================================
   CONFIG
===================================================== */

const INTEGRATION_ID = "noodlefactory-help"; // stable id for help:register
const INTEGRATION_NAME = "Ask Mappy";

// This icon is ONLY for the (?) help menu entry.
// NOTE: Base-nav (left rail) icon is NOT exposed via basenav:register in the UEF types.
const ICON_PATH = "/nf-help-icon.png"; // must exist: GET /nf-help-icon.png -> 200

// Base navigation (left global rail)
const BASE_NAV_ROUTE_NAME = "ask-mappy"; // stable route name
const BASE_NAV_DISPLAY_NAME = INTEGRATION_NAME;

// Stored by uef-boot.html
const TOKEN_STORAGE_KEY = "uef_user_token";

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

/* =====================================================
   UTILS
===================================================== */

function getIntegrationHost() {
  return `${window.location.protocol}//${window.location.hostname}${
    window.location.port ? `:${window.location.port}` : ""
  }`;
}

function getLmsHost() {
  // uef-boot.html sets window.__lmsHost
  if (typeof window.__lmsHost === "string" && window.__lmsHost.trim()) {
    return window.__lmsHost.trim();
  }

  // Fallback to referrer origin (best-effort)
  try {
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref) return ref.origin;
  } catch {}

  return "";
}

function getToken() {
  // uef-boot.html sets window.__token (and stores it)
  if (typeof window.__token === "string" && window.__token.trim()) {
    return window.__token.trim();
  }
  const t = localStorage.getItem(TOKEN_STORAGE_KEY);
  return (t || "").trim();
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
    console.warn(
      "[UEF] Missing LMS host. window.__lmsHost not set and referrer unavailable."
    );
    return;
  }

  // Post "integration:hello" to the parent frame (Ultra)
  window.parent.postMessage({ type: "integration:hello" }, `${lmsHost}/*`);
}

function onPostMessageReceived(event) {
  const lmsHost = getLmsHost();
  if (!lmsHost) return;

  if (event.origin !== lmsHost) return;

  const msg = event.data || {};
  if (!msg.type) return;

  const isHandshakeMsg =
    msg.type === "integration:hello" || msg.type === "integration:port";
  if (!isHandshakeMsg) return;

  const port = event.ports && event.ports[0];
  if (!port) {
    console.warn(
      "[UEF] Handshake message received but no MessagePort provided:",
      msg
    );
    return;
  }

  if (messageChannel) {
    console.log(
      "[UEF] Handshake received; MessagePort already set. Ignoring extra port."
    );
    return;
  }

  messageChannel = new LoggedMessageChannel(port);
  console.log("[UEF] Handshake complete; MessagePort acquired.");

  authorize();
}

/* =====================================================
   AUTH
===================================================== */

function authorize() {
  const token = getToken();
  if (!token) {
    console.warn(
      "[UEF] No UEF user token found. Did you launch through /uef-boot.html?"
    );
    return;
  }

  messageChannel.postMessage({
    type: "authorization:authorize",
    token,
  });
}

/* =====================================================
   REGISTRATIONS
===================================================== */

function registerHelpProvider() {
  if (!messageChannel || !isAuthorized || helpRegistered) return;

  const integrationHost = getIntegrationHost();
  const iconUrl = `${integrationHost}${ICON_PATH}`;

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

  const integrationHost = getIntegrationHost();
  const widgetUrl = `${integrationHost}/widget.html`;

  // Key fix: include a Link element in `contents` so the nav entry is visible/clickable.
  // Docs show `contents` Link example and Link shape (tag/props.to/children).
  messageChannel.postMessage({
    type: "basenav:register",
    displayName: BASE_NAV_DISPLAY_NAME,
    routeName: BASE_NAV_ROUTE_NAME,

    // This creates the clickable item in the base navigation UI
    contents: {
      tag: "Link",
      props: { to: BASE_NAV_ROUTE_NAME },
      children: BASE_NAV_DISPLAY_NAME,
    },

    // This is what renders when the user navigates to the route
    initialContents: {
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

/* =====================================================
   PANEL OPEN + RENDER (used for Help Provider click)
===================================================== */

function renderWidgetIntoPortal(portalId) {
  const integrationHost = getIntegrationHost();
  const widgetUrl = `${integrationHost}/widget.html`;

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

function ensurePanelOpenAndRendered() {
  if (!messageChannel || !isAuthorized) return;

  if (currentPortalId) {
    renderWidgetIntoPortal(currentPortalId);
    return;
  }

  currentPanelCorrelationId = randomId("nf-panel");
  currentCloseCallbackId = `${currentPanelCorrelationId}-close`;

  messageChannel.postMessage({
    type: "portal:panel",
    correlationId: currentPanelCorrelationId,
    panelType: "small",
    panelTitle: INTEGRATION_NAME,
    attributes: {
      onClose: { callbackId: currentCloseCallbackId },
    },
  });
}

/* =====================================================
   HELP REQUEST HANDLER
===================================================== */

function handleHelpRequest(message) {
  const correlationId = message.correlationId;

  console.log("[UEF] help:request received:", {
    correlationId,
    currentRouteName: message.currentRouteName,
    helpUrl: message.helpUrl,
    timeout: message.timeout,
  });

  // Must respond within timeout
  messageChannel.postMessage({
    type: "help:request:response",
    correlationId,
  });

  // Open our panel and render the widget there
  ensurePanelOpenAndRendered();
}

/* =====================================================
   MESSAGE ROUTER (FROM ULTRA)
===================================================== */

function onMessageFromUltra(event) {
  const message = event.data || {};
  if (!message.type) return;

  console.log("[UEF] ←", message);

  if (message.type === "authorization:authorize") {
    isAuthorized = true;

    // Optional subscription: useful for debug (not required for help)
    messageChannel.postMessage({
      type: "event:subscribe",
      subscriptions: ["portal:new", "route"],
    });

    registerHelpProvider();
    registerBaseNavigationRoute();
    return;
  }

  if (message.type === "authorization:unauthorize") {
    console.error("[UEF] Unauthorized:", message.errorInformation);
    isAuthorized = false;
    helpRegistered = false;
    baseNavRegistered = false;
    return;
  }

  if (message.type === "help:register") {
    helpRegistered = message.status === "success";
    if (helpRegistered) {
      console.log(`[UEF] Help provider registered as "${INTEGRATION_NAME}".`);
    } else {
      console.error("[UEF] Help provider registration failed:", message);
    }
    return;
  }

  if (message.type === "basenav:register") {
    baseNavRegistered = message.status === "success";
    if (baseNavRegistered) {
      console.log(
        `[UEF] Base nav registered: "${BASE_NAV_DISPLAY_NAME}" (route="${BASE_NAV_ROUTE_NAME}").`
      );
    } else {
      console.error("[UEF] Base navigation registration failed:", message);
    }
    return;
  }

  // Help request events
  if (message.type === "event:event" && message.eventType === "help:request") {
    handleHelpRequest(message);
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

  // Render response
  if (message.type === "portal:render:response") {
    if (message.status !== "success") {
      console.error(
        "[UEF] portal:render failed:",
        message.error,
        message.errorMessage
      );
    } else {
      console.log(
        "[UEF] portal:render success for portalId:",
        message.portalId
      );
    }
    return;
  }
}

/* =====================================================
   BOOT
===================================================== */

window.addEventListener("message", onPostMessageReceived);

startHandshake();
