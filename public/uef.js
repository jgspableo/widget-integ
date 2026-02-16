(() => {
  const LOG = (...a) => console.log("[UEF]", ...a);
  const WARN = (...a) => console.warn("[UEF]", ...a);
  const ERR = (...a) => console.error("[UEF]", ...a);

  // ----------------------------
  // Config / Derived URLs
  // ----------------------------
  const BASE_URL = window.location.origin;
  const WIDGET_URL = `${BASE_URL}/widget.html`;

  // LEARN_HOST is best provided by uef-boot.html:
  //   <script>window.__UEF_LEARN_HOST = "https://mapua-test.blackboard.com";</script>
  const LEARN_HOST = (
    window.__UEF_LEARN_HOST ||
    localStorage.getItem("UEF_LEARN_HOST") ||
    ""
  ).trim();

  let LEARN_ORIGIN = "";
  try {
    if (LEARN_HOST) LEARN_ORIGIN = new URL(LEARN_HOST).origin;
  } catch {
    // ignore
  }

  // Token comes from uef-boot.html?token=...
  const qs = new URLSearchParams(window.location.search);
  const tokenFromUrl = (qs.get("token") || "").trim();
  if (tokenFromUrl) localStorage.setItem("UEF_USER_TOKEN", tokenFromUrl);

  const TOKEN = (
    tokenFromUrl ||
    localStorage.getItem("UEF_USER_TOKEN") ||
    ""
  ).trim();

  if (!LEARN_ORIGIN) {
    WARN("Missing LEARN_ORIGIN. Set window.__UEF_LEARN_HOST in uef-boot.html.");
    return;
  }
  if (!TOKEN) {
    WARN("Missing TOKEN. uef-boot.html must be called with ?token=...");
    return;
  }

  // ----------------------------
  // UEF Port / State
  // ----------------------------
  let port = null;
  let portalId = null;
  let pendingRender = false;

  function post(msg) {
    if (!port) return WARN("No MessagePort yet; cannot post:", msg);
    port.postMessage(msg);
  }

  // ----------------------------
  // Handshake
  // ----------------------------
  function startHandshake() {
    const channel = new MessageChannel();

    // Receive messages from Ultra on port1
    channel.port1.onmessage = onUltraMessage;

    // Send port2 to parent (Ultra)
    const hello = { type: "integration:hello" };
    window.parent.postMessage(hello, LEARN_ORIGIN, [channel.port2]);
    LOG("Sent integration:hello to", `${LEARN_ORIGIN}/*`);

    // IMPORTANT: In many UEF examples, the first "integration:hello" response
    // comes in on the port itself, not on window. So we don't rely on window message here.
    // We treat the port as live immediately.
    port = channel.port1;

    // Now authorize
    post({ type: "authorization:authorize", token: TOKEN });
    LOG("Posted authorization:authorize");
  }

  // ----------------------------
  // Help Provider registration
  // ----------------------------
  function registerHelpProvider() {
    // Adds an item under the (?) help menu without replacing Blackboard help.
    // registration fields: id, displayName, helpProviderType (auxiliary/primary)
    // See docs. :contentReference[oaicite:6]{index=6}
    post({
      type: "help:register",
      registration: {
        id: "nf-widget-help",
        displayName: "NF Widget",
        helpProviderType: "auxiliary",
      },
    });
    LOG("Posted help:register (auxiliary)");
  }

  // ----------------------------
  // Portal helpers (right-side panel)
  // ----------------------------
  function openPanelAndRender() {
    pendingRender = true;
    post({ type: "portal:panel" });
    LOG("Requested portal:panel");
  }

  function renderWidget() {
    if (!portalId) return;

    post({
      type: "portal:render",
      portalId,
      iframe: {
        src: WIDGET_URL,
        title: "NF Widget",
      },
    });

    LOG("Posted portal:render iframe ->", WIDGET_URL);
    pendingRender = false;
  }

  // ----------------------------
  // Ultra message handler
  // ----------------------------
  function onUltraMessage(evt) {
    const msg = evt?.data;

    // Always log raw messages during setup (this is the #1 thing that saves time)
    LOG("From Ultra:", msg);

    if (!msg || typeof msg !== "object") return;

    // ✅ AUTHORIZE RESPONSE IS ALSO "authorization:authorize" (not "...:response") :contentReference[oaicite:7]{index=7}
    if (msg.type === "authorization:authorize") {
      if (msg.status === "success") {
        LOG("Authorize OK ✅");

        // Register help menu item now
        registerHelpProvider();
      } else {
        ERR("Authorize FAILED:", msg);
      }
      return;
    }

    if (msg.type === "authorization:unauthorize") {
      ERR("Unauthorized:", msg);
      return;
    }

    if (msg.type === "help:register:response") {
      if (msg.status === "success") {
        LOG(
          "help:register success ✅ (refresh Ultra shell if you don't see it yet)"
        );
      } else {
        ERR("help:register FAILED:", msg);
        WARN(
          "If this fails, your token likely lacks the help scope (ultra:help)."
        );
      }
      return;
    }

    // Help clicks come in as event:event with eventType help:request :contentReference[oaicite:8]{index=8}
    if (msg.type === "event:event" && msg.eventType === "help:request") {
      LOG("help:request received ✅");
      // Open right panel + render widget
      openPanelAndRender();

      // Some environments expect an ack; keep it minimal.
      if (msg.correlationId) {
        post({
          type: "help:request:response",
          correlationId: msg.correlationId,
          status: "success",
        });
        LOG("Posted help:request:response");
      }
      return;
    }

    if (msg.type === "portal:panel:response") {
      if (msg.status === "success" && msg.portalId) {
        portalId = msg.portalId;
        LOG("portal:panel success, portalId =", portalId);

        if (pendingRender) renderWidget();
      } else {
        ERR("portal:panel failed:", msg);
      }
      return;
    }

    if (msg.type === "portal:render:response") {
      if (msg.status === "success") LOG("portal:render success ✅");
      else ERR("portal:render failed:", msg);
      return;
    }
  }

  // Go
  startHandshake();
})();
