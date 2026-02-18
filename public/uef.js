/**
 * UEF integration script (runs inside Blackboard Learn Ultra).
 *
 * Goal (your request):
 * - Show "Ask Mappy" in the LEFT base navigation (global rail)
 * - Make it look like native nav items (Marks, Courses, etc.)
 * - When user clicks it, OPEN a RIGHT-SIDE PANEL and load widget.html in an iframe.
 * - Keep the (?) Help menu entry and make it open the same panel.
 *
 * Notes:
 * - Base nav register supports `initialContents`
 * - Click callbacks use `props.onClick.callbackId` and return via `portal:callback`
 */

const CFG = {
  // Help provider
  helpProviderId: "noodlefactory-help",
  displayName: "Ask Mappy",
  providerType: "auxiliary",

  // Base nav
  baseNavRouteName: "ask-mappy",
  baseNavAltRouteName: "base.ask-mappy",

  // Assets
  iconPath: "/nf-help-icon.png",
  widgetPath: "/widget.html",

  // Token storage key (set by uef-boot.html)
  tokenStorageKey: "UEF_BEARER_TOKEN",

  // Panel config
  panelType: "small",
  panelTitle: "Ask Mappy",
};

let port = null;
let authorized = false;

let helpRegistered = false;
let baseNavRegistered = false;

let portalId = null;
let panelCorrelationId = null;
let closeCallbackId = null;

// Base-nav portal slot
let baseNavButtonPortalId = null;

// Callback ids
const BASE_NAV_OPEN_CALLBACK_ID = "ask-mappy-open";

/* ------------------------- helpers ------------------------- */

function getIntegrationOrigin() {
  return `${window.location.protocol}//${window.location.hostname}${
    window.location.port ? `:${window.location.port}` : ""
  }`;
}

function getIconUrl() {
  return `${getIntegrationOrigin()}${CFG.iconPath}`;
}

function getWidgetUrl() {
  return `${getIntegrationOrigin()}${CFG.widgetPath}`;
}

function getLmsHost() {
  if (typeof window.__lmsHost === "string" && window.__lmsHost.trim()) {
    return window.__lmsHost.trim();
  }
  try {
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref) return ref.origin;
  } catch {}
  return "";
}

function getToken() {
  if (typeof window.__token === "string" && window.__token.trim()) {
    return window.__token.trim();
  }
  return (localStorage.getItem(CFG.tokenStorageKey) || "").trim();
}

function rid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function logOut(msg, obj) {
  if (obj !== undefined) console.log(`[UEF] ${msg}`, obj);
  else console.log(`[UEF] ${msg}`);
}

/* --------------------- message send wrapper --------------------- */

function send(message) {
  if (!port) return;
  logOut("→", message);
  port.postMessage(message);
}

/* ------------------------- base-nav contents ------------------------- */

function buildBaseNavButtonContents() {
  // Styling is intentionally inline to mimic native items without relying on private MUI classnames.
  return {
    tag: "button",
    props: {
      type: "button",
      "aria-label": CFG.displayName,
      onClick: { callbackId: BASE_NAV_OPEN_CALLBACK_ID, mode: "sync" },
      style: {
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        width: "100%",
        height: "38px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "0 16px",
        color: "inherit",
      },
    },
    children: [
      {
        tag: "img",
        props: {
          src: getIconUrl(),
          alt: "",
          style: {
            width: "18px",
            height: "18px",
            display: "block",
            flex: "0 0 auto",
          },
        },
      },
      {
        tag: "span",
        props: {
          style: {
            fontSize: "14px",
            lineHeight: "20px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
        },
        children: CFG.displayName,
      },
    ],
  };
}

function renderBaseNavButton() {
  if (!baseNavButtonPortalId) return;

  send({
    type: "portal:render",
    portalId: baseNavButtonPortalId,
    contents: buildBaseNavButtonContents(),
  });
}

/* ------------------------- handshake ------------------------- */

function startHandshake() {
  const lmsHost = getLmsHost();
  if (!lmsHost) {
    console.warn("[UEF] Missing LMS host (window.__lmsHost not set).");
    return;
  }
  window.parent.postMessage({ type: "integration:hello" }, `${lmsHost}/*`);
}

window.addEventListener("message", (event) => {
  const lmsHost = getLmsHost();
  if (!lmsHost) return;
  if (event.origin !== lmsHost) return;

  const data = event.data || {};
  if (!data.type) return;

  if (data.type !== "integration:hello" && data.type !== "integration:port")
    return;

  const p = event.ports && event.ports[0];
  if (!p) {
    console.warn("[UEF] Handshake message received but no MessagePort.");
    return;
  }

  if (port) return;

  port = p;
  port.onmessage = onPortMessage;

  authorize();
});

/* ------------------------- auth + subscribe ------------------------- */

function authorize() {
  const token = getToken();
  if (!token) {
    console.warn(
      "[UEF] No UEF token found. Ensure /uef-boot.html ran and stored it."
    );
    return;
  }
  send({ type: "authorization:authorize", token });
}

function subscribeEvents() {
  send({
    type: "event:subscribe",
    subscriptions: [
      "route",
      "portal:new",
      "portal:remove",
      "click",
      "help:request",
    ],
  });
}

/* ------------------------- registrations ------------------------- */

function registerHelpProvider() {
  if (helpRegistered) return;
  send({
    type: "help:register",
    id: CFG.helpProviderId,
    displayName: CFG.displayName,
    providerType: CFG.providerType,
    iconUrl: getIconUrl(),
  });
}

function registerBaseNav() {
  if (baseNavRegistered) return;

  send({
    type: "basenav:register",
    displayName: CFG.displayName,
    routeName: CFG.baseNavRouteName,
    initialContents: buildBaseNavButtonContents(),
  });
}

/* ------------------------- panel open + render ------------------------- */

function renderWidget(targetPortalId) {
  send({
    type: "portal:render",
    portalId: targetPortalId,
    contents: {
      tag: "div",
      props: {
        style: { height: "100%", width: "100%", padding: "0", margin: "0" },
      },
      children: [
        {
          tag: "iframe",
          props: {
            src: getWidgetUrl(),
            style: { border: "0", height: "100%", width: "100%" },
          },
        },
      ],
    },
  });
}

function openPanel(reason) {
  if (!authorized) return;

  if (portalId) {
    logOut(`Panel already open; re-render (${reason}).`);
    renderWidget(portalId);
    return;
  }

  panelCorrelationId = rid("ask-mappy-panel");
  closeCallbackId = `${panelCorrelationId}-close`;

  send({
    type: "portal:panel",
    correlationId: panelCorrelationId,
    panelType: CFG.panelType,
    panelTitle: CFG.panelTitle,
    attributes: { onClose: { callbackId: closeCallbackId } },
  });
}

/* ------------------------- handlers ------------------------- */

function handleRouteEvent(msg) {
  const rn = msg.routeName;
  if (rn !== CFG.baseNavRouteName && rn !== CFG.baseNavAltRouteName) return;
  openPanel("basenav-route");
}

function handleHelpRequest(msg) {
  send({ type: "help:request:response", correlationId: msg.correlationId });
  openPanel("help-menu");
}

function handlePortalNew(msg) {
  if (msg.selector === "base.navigation.button") {
    baseNavButtonPortalId = msg.portalId;
    renderBaseNavButton();
  }
}

function handlePortalRemove(msg) {
  if (msg.portalId && msg.portalId === baseNavButtonPortalId) {
    baseNavButtonPortalId = null;
  }
}

function handlePortalCallback(msg) {
  const callbackId = msg.callbackId;
  if (!callbackId) return;

  if (callbackId === BASE_NAV_OPEN_CALLBACK_ID) {
    openPanel("base-nav-click");
    return;
  }

  if (closeCallbackId && callbackId === closeCallbackId) {
    logOut("Panel closed.");
    portalId = null;
    panelCorrelationId = null;
    closeCallbackId = null;
  }
}

/* ------------------------- port message router ------------------------- */

function onPortMessage(event) {
  const msg = event.data || {};
  if (!msg.type) return;

  logOut("←", msg);

  if (msg.type === "authorization:authorize") {
    authorized = true;
    subscribeEvents();
    registerHelpProvider();
    registerBaseNav();
    return;
  }

  if (msg.type === "authorization:unauthorize") {
    authorized = false;
    helpRegistered = false;
    baseNavRegistered = false;
    console.error("[UEF] Unauthorized:", msg.errorInformation || msg);
    return;
  }

  if (msg.type === "help:register") {
    helpRegistered = msg.status === "success";
    return;
  }

  if (msg.type === "basenav:register") {
    baseNavRegistered = msg.status === "success";
    return;
  }

  if (msg.type === "help:request") {
    handleHelpRequest(msg);
    return;
  }

  if (msg.type === "event:event") {
    if (msg.eventType === "route") return handleRouteEvent(msg);
    if (msg.eventType === "help:request") return handleHelpRequest(msg);
    if (msg.eventType === "portal:new") return handlePortalNew(msg);
    if (msg.eventType === "portal:remove" || msg.eventType === "portal:removed")
      return handlePortalRemove(msg);
    return;
  }

  if (msg.type === "portal:callback") {
    handlePortalCallback(msg);
    return;
  }

  if (msg.type === "portal:panel:response") {
    if (!panelCorrelationId || msg.correlationId !== panelCorrelationId) return;

    if (msg.status !== "success") {
      console.error("[UEF] portal:panel failed:", msg);
      portalId = null;
      panelCorrelationId = null;
      closeCallbackId = null;
      return;
    }

    portalId = msg.portalId;
    logOut("Panel opened. portalId =", portalId);
    renderWidget(portalId);
    return;
  }
}

/* ------------------------- boot ------------------------- */

startHandshake();
