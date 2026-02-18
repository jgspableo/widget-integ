/**
 * UEF integration script (runs inside Blackboard Learn Ultra).
 *
 * Goal (your request):
 * - Show "Ask Mappy" in the LEFT base navigation (global rail)
 * - When user clicks it, OPEN a RIGHT-SIDE PANEL and load your widget (widget.html) in an iframe.
 * - Keep the (?) Help menu entry (with your custom icon) and make it open the same panel.
 *
 * Key UEF details:
 * - Base nav registration example uses a Link element in `contents` so the nav entry is clickable/visible.
 * - Route events include `routeName`, so we can detect when user navigates to our route.
 * - You must subscribe to events via `event:subscribe` after successful authorization.
 */

const CFG = {
  // Help provider
  helpProviderId: "noodlefactory-help",
  displayName: "Ask Mappy",
  providerType: "auxiliary", // shows under (?) help menu

  // Base nav (left rail)
  baseNavRouteName: "ask-mappy",

  // Static assets served by your integration host (Render)
  iconPath: "/nf-help-icon.png",
  widgetPath: "/widget.html",

  // Token storage key (set by uef-boot.html)
  tokenStorageKey: "uef_user_token",

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

// gate to avoid repeated opens on multiple route events
let openedFromBaseNav = false;

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

  if (port) {
    logOut("MessagePort already set; ignoring extra port.");
    return;
  }

  port = p;
  port.onmessage = onPortMessage;
  logOut("Handshake complete; MessagePort acquired.");

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
    subscriptions: ["route", "portal:new", "portal:remove"],
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

    // Left-rail clickable entry
    contents: {
      tag: "Link",
      props: { to: CFG.baseNavRouteName },
      children: CFG.displayName,
    },

    // Route page content (keep it light; panel is the real UI)
    initialContents: {
      tag: "div",
      props: { style: { padding: "16px", fontFamily: "inherit" } },
      children: [
        {
          tag: "h2",
          props: { style: { margin: "0 0 8px 0" } },
          children: ["Opening Ask Mappy…"],
        },
        {
          tag: "p",
          props: { style: { margin: "0", opacity: "0.8" } },
          children: [
            "If the panel did not open, refresh the page and try again.",
          ],
        },
      ],
    },
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
  if (msg.routeName !== CFG.baseNavRouteName) {
    openedFromBaseNav = false;
    return;
  }

  if (openedFromBaseNav) return;
  openedFromBaseNav = true;

  openPanel("basenav-route");
}

function handleHelpRequest(msg) {
  send({ type: "help:request:response", correlationId: msg.correlationId });
  openPanel("help-menu");
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

  if (msg.type === "event:event") {
    if (msg.eventType === "route") {
      handleRouteEvent(msg);
      return;
    }
    if (msg.eventType === "help:request") {
      handleHelpRequest(msg);
      return;
    }
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

  if (msg.type === "portal:callback") {
    if (msg.callbackId === closeCallbackId) {
      logOut("Panel closed.");
      portalId = null;
      panelCorrelationId = null;
      closeCallbackId = null;
    }
    return;
  }
}

/* ------------------------- boot ------------------------- */

startHandshake();
