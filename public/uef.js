/**
 * UEF Integration Script (public/uef.js)
 *
 * Goal:
 * - Register "Noodle Factory" as an AUXILIARY Help Provider (question-mark menu entry)
 * - Only open the right-side panel + render the widget when the user clicks that entry
 *
 * References:
 * - Help provider registration: type 'help:register' :contentReference[oaicite:3]{index=3}
 * - Help request event: type 'event:event', eventType 'help:request' :contentReference[oaicite:4]{index=4}
 * - Portal rendering flow: subscribe to portal:new, then portal:panel, then portal:render :contentReference[oaicite:5]{index=5}
 */

(function () {
  // ============================================================
  // CONFIG
  // ============================================================
  const TOOL_HOST = window.location.origin; // e.g. https://widget-integ.onrender.com

  // Help provider identity shown in Ultra's question-mark menu
  const HELP_PROVIDER_ID = "noodlefactory-help";
  const HELP_PROVIDER_NAME = "Noodle Factory";
  const HELP_PROVIDER_TYPE = "auxiliary"; // shows as a menu entry under the ? help menu :contentReference[oaicite:6]{index=6}

  // Icon must be publicly reachable via iconUrl
  const HELP_ICON_URL = `${TOOL_HOST}/nf-help-icon.png`;

  // Panel settings
  const PANEL_CORRELATION_ID = "nf-help-panel";
  const PANEL_TITLE = "Ask Mappy!"; // You can set "" but Ultra will still show panel chrome
  const PANEL_TYPE = "small"; // 'small' or 'large' depending on your preference

  // What to render inside the portal
  const WIDGET_PAGE_URL = `${TOOL_HOST}/widget.html`;

  // ============================================================
  // STATE
  // ============================================================
  let messageChannel = null;
  let messagePort = null;

  let portalId = null; // active portal to render into (set on portal:new)
  let panelOpened = false;

  // ============================================================
  // TOKEN HELPERS (matches your existing logic)
  // ============================================================
  function getToken() {
    return localStorage.getItem("uef_user_token") || "";
  }

  function saveToken(token) {
    if (!token) return;
    localStorage.setItem("uef_user_token", token);
  }

  // ============================================================
  // UEF WIRING
  // ============================================================
  window.addEventListener("message", (incomingMessage) => {
    // We only care about the initial hello (MessagePort handoff)
    const data = incomingMessage?.data;
    if (!data || typeof data !== "object") return;

    // Blackboard Ultra will send a handshake; your instance uses integration:hello
    if (data.type === "integration:hello") {
      console.log(
        "[UEF] integration:hello received; using provided MessagePort."
      );

      if (!incomingMessage.ports || !incomingMessage.ports[0]) {
        console.warn("[UEF] No MessagePort provided in integration:hello.");
        return;
      }

      messagePort = incomingMessage.ports[0];
      messageChannel = messagePort;

      messagePort.onmessage = onMessageFromUltra;

      authorizeWithUEF();
    }
  });

  // Kick off handshake to parent window (Ultra)
  // NOTE: targetOrigin is '*' because Blackboard origin differs per instance.
  // If you know exact origin, you can lock it down.
  window.parent.postMessage({ type: "integration:hello" }, "*");

  // ============================================================
  // AUTH
  // ============================================================
  function authorizeWithUEF() {
    const token = getToken();

    // Request authorization scopes needed for:
    // - help provider registration (ultra:help)
    // - portal rendering (ultra:portal)
    const authRequest = {
      type: "authorization:authorize",
      token,
      auth: ["ultra:help", "ultra:portal"],
    };

    messageChannel.postMessage(authRequest);
  }

  function onMessageFromUltra(evt) {
    const data = evt?.data;
    if (!data || typeof data !== "object") return;

    // ------------------------------------------------------------
    // AUTH RESULT
    // ------------------------------------------------------------
    if (data.type === "authorization:authorize") {
      if (data.status === "success") {
        console.log("[UEF] Authorized with UEF.");

        // Some UEF setups return a token; keep your existing behavior
        if (data.token) saveToken(data.token);

        initializeAfterAuth();
      } else {
        console.error("[UEF] Authorization failed:", data);
      }
      return;
    }

    // ------------------------------------------------------------
    // PORTAL EVENTS (portal:new / portal:remove)
    // Note: subscription is 'portal:new', but the event payload uses eventType 'new'
    // in many UEF docs/examples. :contentReference[oaicite:7]{index=7}
    // ------------------------------------------------------------
    if (data.type === "event:event" && data.portalId && data.eventType) {
      if (data.eventType === "new") {
        // We only want to capture a portal after we open our panel
        if (panelOpened) {
          portalId = data.portalId;
          // Render immediately when the portal becomes available
          renderWidgetIntoPortal(portalId);
        }
      }

      if (data.eventType === "remove") {
        if (portalId && data.portalId === portalId) {
          portalId = null;
          panelOpened = false;
        }
      }
      return;
    }

    // ------------------------------------------------------------
    // HELP REQUEST (user clicked your help entry in the ? menu)
    // UEF sends: { type:'event:event', eventType:'help:request', correlationId, ... } :contentReference[oaicite:8]{index=8}
    // ------------------------------------------------------------
    if (data.type === "event:event" && data.eventType === "help:request") {
      console.log("[UEF] Help requested:", data);

      // Respond quickly to acknowledge the help request (recommended by UEF)
      // Response type is 'help:request:response' and must echo correlationId :contentReference[oaicite:9]{index=9}
      messageChannel.postMessage({
        type: "help:request:response",
        correlationId: data.correlationId,
      });

      // Open panel + render widget
      openPanel();
      return;
    }

    // ------------------------------------------------------------
    // HELP REGISTER RESPONSE (informational)
    // ------------------------------------------------------------
    if (data.type === "help:register") {
      console.log("[UEF] Help provider register response:", data);
      return;
    }

    // ------------------------------------------------------------
    // PORTAL RENDER RESPONSE (informational)
    // ------------------------------------------------------------
    if (data.type === "portal:render:response") {
      if (data.status !== "success") {
        console.warn("[UEF] portal:render:response non-success:", data);
      }
      return;
    }
  }

  // ============================================================
  // INIT AFTER AUTH
  // ============================================================
  function initializeAfterAuth() {
    // Subscribe to portal:new so we get a portalId when our panel opens :contentReference[oaicite:10]{index=10}
    messageChannel.postMessage({
      type: "event:subscribe",
      subscriptions: ["portal:new", "portal:remove"],
    });

    // Register as an auxiliary help provider (question-mark menu entry) :contentReference[oaicite:11]{index=11}
    messageChannel.postMessage({
      type: "help:register",
      id: HELP_PROVIDER_ID,
      displayName: HELP_PROVIDER_NAME,
      providerType: HELP_PROVIDER_TYPE,
      iconUrl: HELP_ICON_URL,
    });

    console.log(
      "[UEF] Ready. Widget will open when user clicks the ? menu entry."
    );
  }

  // ============================================================
  // PANEL + RENDER
  // ============================================================
  function openPanel() {
    panelOpened = true;

    messageChannel.postMessage({
      type: "portal:panel",
      correlationId: PANEL_CORRELATION_ID,
      panelType: PANEL_TYPE,
      panelTitle: PANEL_TITLE,
      closeable: true,
    });
  }

  function renderWidgetIntoPortal(targetPortalId) {
    if (!targetPortalId) return;

    // Render an iframe that fills the panel.
    // This is standard portal rendering with a standard element 'iframe'. :contentReference[oaicite:12]{index=12}
    messageChannel.postMessage({
      type: "portal:render",
      portalId: targetPortalId,
      contents: [
        {
          tag: "span",
          props: {
            style: {
              display: "block",
              width: "100%",
              height: "100%",
            },
          },
          children: [
            {
              tag: "iframe",
              props: {
                src: WIDGET_PAGE_URL,
                style: {
                  border: "0",
                  width: "100%",
                  height: "100%",
                  display: "block",
                },
              },
            },
          ],
        },
      ],
    });
  }
})();
