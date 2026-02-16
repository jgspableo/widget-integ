// public/uef.js
(() => {
  const LOG_PREFIX = "[UEF]";

  // Must match the Learn origin you are iframed into.
  const LEARN_ORIGIN = (
    window.__lmsHost || "https://mapua-test.blackboard.com"
  ).replace(/\/+$/, "");
  const integrationHost = `${location.protocol}//${location.host}`;

  // Help Provider config
  const HELP_PROVIDER_ID = (
    window.__helpProviderId || "noodlefactory-help"
  ).trim();
  const HELP_DISPLAY_NAME = "Noodle Factory";
  const HELP_PROVIDER_TYPE = "auxiliary"; // shows as an entry in the (?) Help menu
  const HELP_ICON_URL = `${integrationHost}/nf-help-icon.png`;

  // Panel + widget config
  const PANEL_PATH = "/widget.html";
  const PANEL_CORRELATION_ID = "nf-widget-panel";
  const PANEL_TITLE = "Noodle Factory Help";
  const PANEL_TYPE = "small";

  let uefPort = null;
  let authorized = false;

  let portalId = null;
  let widgetRendered = false;

  const log = (...a) => console.log(LOG_PREFIX, ...a);
  const warn = (...a) => console.warn(LOG_PREFIX, ...a);
  const err = (...a) => console.error(LOG_PREFIX, ...a);

  function getBearerToken() {
    if (window.__token && typeof window.__token === "string")
      return window.__token;
    return (
      localStorage.getItem("uef_user_token") ||
      localStorage.getItem("UEF_BEARER_TOKEN") ||
      ""
    );
  }

  function postHello() {
    // UEF docs / examples commonly show using learn_url + '/*' for the handshake. :contentReference[oaicite:1]{index=1}
    // If you ever see a browser error about invalid targetOrigin, change this to LEARN_ORIGIN (no /*).
    window.parent.postMessage(
      { type: "integration:hello" },
      `${LEARN_ORIGIN}/*`
    );
  }

  function registerHelpProvider() {
    if (!uefPort || !authorized) return;

    uefPort.postMessage({
      type: "help:register",
      id: HELP_PROVIDER_ID,
      displayName: HELP_DISPLAY_NAME,
      providerType: HELP_PROVIDER_TYPE,
      iconUrl: HELP_ICON_URL,
    });

    log("Sent help:register", {
      id: HELP_PROVIDER_ID,
      providerType: HELP_PROVIDER_TYPE,
    });
  }

  function openPanel() {
    if (!uefPort || !authorized) return;

    uefPort.postMessage({
      type: "portal:panel",
      correlationId: PANEL_CORRELATION_ID,
      panelType: PANEL_TYPE,
      panelTitle: PANEL_TITLE,
    });
  }

  function renderWidget() {
    if (!uefPort || !portalId) return;

    uefPort.postMessage({
      type: "portal:render",
      portalId,
      contents: {
        tag: "Iframe",
        src: `${integrationHost}${PANEL_PATH}`,
        title: PANEL_TITLE,
        width: "100%",
        height: "100%",
        scrollable: false,
      },
    });
  }

  function handleHelpRequest(msg) {
    log("Received help:request", msg);

    openPanel();

    // Respond to the request using the same correlationId. :contentReference[oaicite:2]{index=2}
    uefPort.postMessage({
      type: "help:request:response",
      correlationId: msg.correlationId,
    });
  }

  function onUEFMessage(data) {
    if (!data || !data.type) return;

    if (data.type === "authorization:authorize") {
      authorized = true;
      log("Authorized with UEF.");

      // Help provider registration requires ultra:help entitlement. :contentReference[oaicite:3]{index=3}
      registerHelpProvider();
      return;
    }

    if (data.type === "authorization:unauthorize") {
      authorized = false;
      warn("Unauthorized by UEF.", data);
      return;
    }

    if (data.type === "help:register") {
      log("Help provider register response:", data);
      return;
    }

    // Help menu click comes in as an event occurrence with eventType "help:request".
    if (data.type === "event:event" && data.eventType === "help:request") {
      handleHelpRequest(data);
      return;
    }

    if (data.type === "portal:panel:response") {
      if (data.correlationId === PANEL_CORRELATION_ID && data.portalId) {
        portalId = data.portalId;
        log("Panel opened, portalId =", portalId);

        if (!widgetRendered) renderWidget();
      }
      return;
    }

    if (data.type === "portal:render:response") {
      if (data.portalId === portalId) {
        widgetRendered = true;
        log("Widget rendered into portal.");
      }
      return;
    }
  }

  // ✅ Correct handshake:
  // Ultra replies to integration:hello with a MessagePort in event.ports[0]. Use that. :contentReference[oaicite:4]{index=4}
  window.addEventListener("message", (event) => {
    if (event.origin !== LEARN_ORIGIN) return;

    const data = event.data;
    if (!data || data.type !== "integration:hello") return;

    const port = event.ports && event.ports[0];
    if (!port) {
      err(
        "integration:hello received but no MessagePort provided in event.ports[0]"
      );
      return;
    }

    log("integration:hello received; using provided MessagePort.");
    uefPort = port;

    uefPort.onmessage = (evt) => onUEFMessage(evt.data);
    uefPort.start && uefPort.start();

    const token = getBearerToken();
    if (!token) {
      warn("Missing bearer token; cannot authorize.");
      return;
    }

    uefPort.postMessage({
      type: "authorization:authorize",
      token,
    });
  });

  postHello();
})();
