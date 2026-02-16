/**
 * UEF integration script (runs inside Blackboard Ultra).
 *
 * Goal:
 * - Register as a Help Provider so you appear under the (?) help menu as an entry.
 * - Open a right-side UEF panel ONLY when the user clicks your help entry.
 * - Render your hosted widget page inside that panel (iframe).
 *
 * References:
 * - Help provider register: https://docs.anthology.com/uef-documentation/interfaces/ihelpproviderregistrationrequest.html
 * - Help request event + response: https://docs.anthology.com/uef-documentation/interfaces/ihelpproviderrequest.html
 * - Panel open request/response: https://docs.anthology.com/uef-documentation/interfaces/inewportalpanelrequest.html
 * - Portal render request + standard element: https://docs.anthology.com/uef-documentation/interfaces/iportalrenderrequest.html
 */

/* =====================================================
   CONFIG
===================================================== */

const INTEGRATION_ID = "noodlefactory-help"; // must be stable; used by help:register
const INTEGRATION_NAME = "Noodle Factory";
const ICON_PATH = "/nf-help-icon.png"; // MUST exist in /public so GET /nf-help-icon.png returns 200

// Stored in local storage by uef-boot.html (or injected via window.__token)
const TOKEN_STORAGE_KEY = "uef_user_token";

/* =====================================================
   STATE
===================================================== */

let messageChannel = null;
let isAuthorized = false;
let helpRegistered = false;

let currentPortalId = null;
let currentPanelCorrelationId = null;

// Used for onClose callback tracking
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
    // Keep this log; it makes UEF debugging 100x easier.
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

  // UEF docs: post "integration:hello" to parent LMS origin
  // https://docs.anthology.com/uef-documentation/get-started/integrate-with-ultra.html
  window.parent.postMessage({ type: "integration:hello" }, `${lmsHost}/*`);
}

// Accept both "integration:hello" and (some environments) "integration:port"
function onPostMessageReceived(event) {
  const lmsHost = getLmsHost();
  if (!lmsHost) return;

  // Strict origin check (avoid grabbing ports from unexpected frames)
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
    // Avoid noisy warnings; sometimes Ultra re-sends ports during reloads.
    console.log(
      "[UEF] Handshake received; MessagePort already set. Ignoring extra port."
    );
    return;
  }

  messageChannel = new LoggedMessageChannel(port);
  console.log("[UEF] Handshake received; using provided MessagePort.");

  authorize();
}

/* =====================================================
   AUTH + HELP PROVIDER REGISTRATION
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

function registerHelpProvider() {
  if (!messageChannel || !isAuthorized || helpRegistered) return;

  const integrationHost = getIntegrationHost();
  const iconUrl = `${integrationHost}${ICON_PATH}`;

  // Docs: IHelpProviderRegistrationRequest
  // https://docs.anthology.com/uef-documentation/interfaces/ihelpproviderregistrationrequest.html
  messageChannel.postMessage({
    type: "help:register",
    id: INTEGRATION_ID,
    displayName: INTEGRATION_NAME,
    providerType: "auxiliary", // "auxiliary" -> appears as an entry in the (?) help menu
    iconUrl,
  });
}

/* =====================================================
   PANEL OPEN + RENDER
===================================================== */

function renderWidgetIntoPortal(portalId) {
  const integrationHost = getIntegrationHost();
  const widgetUrl = `${integrationHost}/widget.html`;

  // Docs:
  // - IPortalRenderRequest: https://docs.anthology.com/uef-documentation/interfaces/iportalrenderrequest.html
  // - IStandardElement: https://docs.anthology.com/uef-documentation/interfaces/istandardelement.html
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

  // If we already have a portal, just re-render (useful if your iframe crashed).
  if (currentPortalId) {
    renderWidgetIntoPortal(currentPortalId);
    return;
  }

  currentPanelCorrelationId = randomId("nf-panel");
  currentCloseCallbackId = `${currentPanelCorrelationId}-close`;

  // Docs: INewPortalPanelRequest
  // https://docs.anthology.com/uef-documentation/interfaces/inewportalpanelrequest.html
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
  // Docs: IHelpProviderRequest / IHelpProviderResponse
  // https://docs.anthology.com/uef-documentation/interfaces/ihelpproviderrequest.html
  // https://docs.anthology.com/uef-documentation/interfaces/ihelpproviderresponse.html

  const correlationId = message.correlationId;

  console.log("[UEF] help:request received:", {
    correlationId,
    currentRouteName: message.currentRouteName,
    helpUrl: message.helpUrl,
    timeout: message.timeout,
  });

  // ACK the help request immediately (UEF expects a response within timeout)
  messageChannel.postMessage({
    type: "help:request:response",
    correlationId,
  });

  // Then open your panel + render your widget
  ensurePanelOpenAndRendered();
}

/* =====================================================
   MESSAGE ROUTER (FROM ULTRA)
===================================================== */

function onMessageFromUltra(event) {
  const message = event.data || {};
  if (!message.type) return;

  // Always log inbound. Again: makes debugging way easier.
  console.log("[UEF] ←", message);

  // Successful auth
  if (message.type === "authorization:authorize") {
    isAuthorized = true;

    // Optional but harmless: subscribe to portal events (not strictly required for help providers)
    messageChannel.postMessage({
      type: "event:subscribe",
      subscriptions: ["portal:new"],
    });

    registerHelpProvider();
    return;
  }

  // Failed auth
  if (message.type === "authorization:unauthorize") {
    console.error("[UEF] Unauthorized:", message.errorInformation);
    isAuthorized = false;
    helpRegistered = false;
    return;
  }

  // Help provider registration response
  if (message.type === "help:register") {
    helpRegistered = message.status === "success";
    if (helpRegistered) {
      console.log(
        `[UEF] Help provider registered as "${INTEGRATION_NAME}" (auxiliary).`
      );
    } else {
      console.error("[UEF] Help provider registration failed:", message);
    }
    return;
  }

  // Help request events come as event:event with eventType help:request
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
      return; // ignore other panels
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

  // Portal close callback
  if (message.type === "portal:callback") {
    if (message.callbackId === currentCloseCallbackId) {
      console.log("[UEF] Panel closed.");
      currentPortalId = null;
      currentPanelCorrelationId = null;
      currentCloseCallbackId = null;
    }
    return;
  }

  // Render response (useful for debugging blank panel issues)
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
