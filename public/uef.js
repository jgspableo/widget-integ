/* public/uef.js */
/* UEF: open a panel and render widget.html inside it */

(() => {
  const LOG_PREFIX = "[UEF]";
  const LMS_HOST = (
    window.__lmsHost || "https://mapua-test.blackboard.com"
  ).replace(/\/+$/, "");
  const PANEL_PATH = "/widget.html";
  const PANEL_CORRELATION_ID = "nf-widget-panel-1";

  const log = (...a) => console.log(LOG_PREFIX, ...a);
  const warn = (...a) => console.warn(LOG_PREFIX, ...a);
  const err = (...a) => console.error(LOG_PREFIX, ...a);

  const integrationHost = `${window.location.protocol}//${window.location.host}`;

  function loadToken() {
    try {
      return localStorage.getItem("uef_user_token") || "";
    } catch {
      return "";
    }
  }

  function saveToken(t) {
    try {
      if (t) localStorage.setItem("uef_user_token", t);
    } catch {
      // ignore (3rd-party storage restrictions)
    }
  }

  // Prefer the token injected by uef-boot.html, fallback to localStorage.
  const token = window.__token || loadToken();
  if (window.__token) saveToken(window.__token);

  let messageChannel = null;
  let authorized = false;
  let portalId = null;

  function postHello() {
    const target = `${LMS_HOST}/*`; // matches UEF docs style
    log("Sent integration:hello to", target);
    window.parent.postMessage({ type: "integration:hello" }, target);
  }

  function sendAuthorize() {
    if (!messageChannel) return;
    if (!token) {
      warn(
        "No token found. uef-boot.html should be redirecting with ?token=..."
      );
      return;
    }
    messageChannel.postMessage({ type: "authorization:authorize", token });
    log("Posted authorization:authorize");
  }

  function subscribeAndOpenPanel() {
    if (!messageChannel || !authorized) return;

    messageChannel.postMessage({
      type: "event:subscribe",
      subscriptions: ["portal:new"],
    });
    log("Subscribed to portal:new");

    messageChannel.postMessage({
      type: "portal:panel",
      correlationId: PANEL_CORRELATION_ID,
      panelType: "small",
      panelTitle: "NF Widget",
      attributes: {
        onClose: { callbackId: `${PANEL_CORRELATION_ID}-close` },
      },
    });
    log("Requested portal:panel");
  }

  function renderPanel() {
    if (!messageChannel || !portalId) return;

    const src = `${integrationHost}${PANEL_PATH}`;

    messageChannel.postMessage({
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
              src,
              style: {
                flex: "1 1 auto",
                width: "100%",
                height: "100%",
                border: "0",
              },
            },
          },
        ],
      },
    });

    log("Posted portal:render iframe ->", src);
  }

  function onMessageFromUltra(message) {
    const data = message?.data || {};

    // Keep this while debugging so you can see what Ultra is sending back.
    log("From Ultra:", data);

    if (data.type === "authorization:authorize") {
      authorized = true;
      log("Authorize OK ✅");
      subscribeAndOpenPanel();
      return;
    }

    if (data.type === "authorization:unauthorize") {
      authorized = false;
      err("Authorize FAILED ❌", data.errorInformation || data);
      return;
    }

    if (
      data.type === "portal:panel:response" &&
      data.correlationId === PANEL_CORRELATION_ID
    ) {
      if (data.status !== "success") {
        err("portal:panel failed:", data);
        return;
      }
      portalId = data.portalId;
      log("portal:panel success, portalId =", portalId);
      renderPanel();
      return;
    }

    if (data.type === "portal:render:response") {
      if (data.status !== "success") err("portal:render failed:", data);
      else log("portal:render success ✅");
      return;
    }

    if (data.type === "portal:callback") {
      log("portal callback:", data);
      return;
    }
  }

  // Step 1: wait for Ultra handshake message
  window.addEventListener(
    "message",
    (evt) => {
      if (!evt?.data || evt.data.type !== "integration:hello") return;
      if (!evt.ports || !evt.ports[0]) {
        err("Handshake response missing MessagePort");
        return;
      }

      messageChannel = evt.ports[0];
      messageChannel.onmessage = onMessageFromUltra;

      log("Handshake complete; MessagePort stored");
      sendAuthorize();
    },
    false
  );

  // Kick off handshake
  postHello();
})();
