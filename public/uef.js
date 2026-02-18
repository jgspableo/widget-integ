/**
 * public/uef.js
 *
 * Behavior:
 * - Help menu (question mark): registers "Ask Mappy" as an auxiliary help provider.
 * - Left Base Nav: shows "Ask Mappy" like other nav items and opens the same right-side panel.
 *
 * Key fixes:
 * - Force visible label color (white-ish)
 * - Prevent Firefox "too much recursion" focus trap loop by:
 *   (1) debouncing panel open requests
 *   (2) opening the panel async on base-nav click (setTimeout 0)
 */

const CFG = {
  helpProviderId: "noodlefactory-help",
  displayName: "Ask Mappy",
  providerType: "auxiliary",

  // Required by basenav registration
  baseNavRouteName: "ask-mappy",

  iconPath: "/nf-help-icon.png",
  widgetPath: "/widget.html",

  tokenStorageKey: "uef_user_token",

  panelType: "small",
  panelTitle: "Ask Mappy",
};

let port = null;
let authorized = false;

let helpRegistered = false;
let baseNavRegistered = false;

// Panel state
let panelPortalId = null;
let panelCorrelationId = null;
let closeCallbackId = null;
let panelOpening = false;
let lastPanelOpenAt = 0;

// Base nav portal (where we render the left nav entry UI)
let baseNavPortalId = null;

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

function send(message) {
  if (!port) return;
  logOut("→", message);
  port.postMessage(message);
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
  logOut("Handshake complete; MessagePort acquired.");

  authorize();
});

/* ------------------------- auth + subscribe ------------------------- */

function authorize() {
  const token = getToken();
  if (!token) {
    console.warn("[UEF] No UEF token found.");
    return;
  }
  send({ type: "authorization:authorize", token });
}

function subscribeEvents() {
  send({
    type: "event:subscribe",
    subscriptions: ["portal:new", "portal:remove", "help:request"],
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

  // Keep registration minimal; we render into the base nav portal for click behavior & styling
  send({
    type: "basenav:register",
    displayName: CFG.displayName,
    routeName: CFG.baseNavRouteName,
  });
}

/* ------------------------- Base Nav Rendering ------------------------- */

function buildBaseNavContents() {
  return {
    tag: "button",
    props: {
      type: "button",
      "aria-label": CFG.displayName,
      onClick: { callbackId: BASE_NAV_OPEN_CALLBACK_ID, mode: "sync" },
      style: {
        width: "100%",
        height: "38px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "0 16px",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        font: "inherit",
      },
    },
    children: [
      {
        tag: "img",
        props: {
          src: getIconUrl(),
          alt: "",
          style: { width: "18px", height: "18px", display: "block" },
        },
      },
      {
        tag: "span",
        props: {
          style: {
            fontSize: "14px",
            lineHeight: "20px",
            // ✅ FIX: force visible color like native Ultra nav
            color: "rgba(255,255,255,0.87)",
            WebkitTextFillColor: "rgba(255,255,255,0.87)",
            whiteSpace: "nowrap",
          },
        },
        children: CFG.displayName,
      },
    ],
  };
}

function renderBaseNav() {
  if (!baseNavPortalId) return;
  send({
    type: "portal:render",
    portalId: baseNavPortalId,
    contents: buildBaseNavContents(),
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
        style: {
          height: "100%",
          width: "100%",
          padding: "0",
          margin: "0",
          display: "flex",
        },
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

  // ✅ If panel already open, just re-render
  if (panelPortalId) {
    renderWidget(panelPortalId);
    return;
  }

  // ✅ Debounce / gate panel opens
  const now = Date.now();
  if (panelOpening) return;
  if (now - lastPanelOpenAt < 250) return;

  panelOpening = true;
  lastPanelOpenAt = now;

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

function handleHelpRequest(msg) {
  send({ type: "help:request:response", correlationId: msg.correlationId });
  openPanel("help-menu");
}

function handlePortalNew(msg) {
  // This is the base nav integration slot portal
  if (msg.selector === "base.navigation.button") {
    baseNavPortalId = msg.portalId;
    renderBaseNav();
  }
}

function handlePortalRemove(msg) {
  if (msg.portalId === baseNavPortalId) baseNavPortalId = null;
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

  if (msg.type === "event:event") {
    if (msg.eventType === "help:request") return handleHelpRequest(msg);
    if (msg.eventType === "portal:new") return handlePortalNew(msg);
    if (msg.eventType === "portal:remove") return handlePortalRemove(msg);
    return;
  }

  if (msg.type === "portal:panel:response") {
    if (!panelCorrelationId || msg.correlationId !== panelCorrelationId) return;

    panelOpening = false;

    if (msg.status !== "success") {
      panelPortalId = null;
      panelCorrelationId = null;
      closeCallbackId = null;
      return;
    }

    panelPortalId = msg.portalId;
    renderWidget(panelPortalId);
    return;
  }

  if (msg.type === "portal:callback") {
    // ✅ Base nav click: open panel async to avoid focus-trap recursion in Firefox
    if (msg.callbackId === BASE_NAV_OPEN_CALLBACK_ID) {
      setTimeout(() => {
        try {
          if (document.activeElement && document.activeElement.blur) {
            document.activeElement.blur();
          }
        } catch {}
        openPanel("base-nav-click");
      }, 0);
      return;
    }

    // ✅ Panel close callback
    if (msg.callbackId === closeCallbackId) {
      panelPortalId = null;
      panelCorrelationId = null;
      closeCallbackId = null;
      panelOpening = false;
      return;
    }
  }
}

/* ------------------------- boot ------------------------- */

startHandshake();
