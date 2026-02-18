/**
 * Ultra Extension Framework (UEF) integration script.
 *
 * Loaded on every Ultra page via a UEF placement (public/uef-boot.html injects this file).
 *
 * Goals:
 *  - Add "Ask Mappy" to the Help menu (question mark) via help:register.
 *  - Add "Ask Mappy" to the Base Navigation (left rail) via basenav:register.
 *  - When either entry is used, open a right-side portal panel and render the
 *    Noodle Factory chatbot widget inside an iframe.
 */

(function () {
  // ------------------------------
  // Config
  // ------------------------------
  const CFG = {
    // Fallback Learn origin (used for handshake targetOrigin).
    // If possible, we infer this from document.referrer at runtime.
    learnOriginFallback: "https://mapua-test.blackboard.com",

    // UI text
    displayName: "Ask Mappy",

    // IDs / route names
    helpProviderId: "noodlefactory-help",
    baseNavRouteName: "ask-mappy",

    // Help menu entry type (matches docs: 'auxiliary' is a common choice)
    helpProviderType: "auxiliary",

    // Your icon hosted on your provider domain
    helpIconUrl: "https://widget-integ.onrender.com/nf-help-icon.png",

    // Widget location
    widgetUrl:
      "https://chatbot.noodlefactory.ai/widget?dataset=Mapua%20-%20Mappy",

    // Portal panel settings
    portalSize: "medium",

    // localStorage keys used by public/uef-boot.html and older versions
    tokenStorageKeyPrimary: "UEF_BEARER_TOKEN",
    tokenStorageKeyLegacy: "uef_user_token",

    // Logging
    logPrefix: "[UEF]",
  };

  // ------------------------------
  // State
  // ------------------------------
  let messagePort = null;
  let authorized = false;

  let helpRegistered = false;
  let baseNavRegistered = false;

  let activePortalId = null;
  let openInProgress = false;

  // ------------------------------
  // Helpers
  // ------------------------------
  function log(...args) {
    // eslint-disable-next-line no-console
    console.log(CFG.logPrefix, ...args);
  }

  function warn(...args) {
    // eslint-disable-next-line no-console
    console.warn(CFG.logPrefix, ...args);
  }

  function error(...args) {
    // eslint-disable-next-line no-console
    console.error(CFG.logPrefix, ...args);
  }

  function inferLearnOrigin() {
    try {
      if (document.referrer) return new URL(document.referrer).origin;
    } catch (_) {
      // ignore
    }
    return CFG.learnOriginFallback;
  }

  function getToken() {
    // uef-boot.html can set window.__token if it extracted it from the URL
    if (typeof window.__token === "string" && window.__token.length > 0) {
      return window.__token;
    }

    try {
      const primary = localStorage.getItem(CFG.tokenStorageKeyPrimary);
      if (primary) return primary;
      const legacy = localStorage.getItem(CFG.tokenStorageKeyLegacy);
      if (legacy) return legacy;
    } catch (_) {
      // ignore
    }

    return null;
  }

  function send(msg) {
    if (!messagePort) {
      warn("send() called before MessagePort is available", msg);
      return;
    }

    log("→", msg);
    messagePort.postMessage(msg);
  }

  // ------------------------------
  // UEF Workflow
  // ------------------------------
  function authorize() {
    if (authorized) return;

    const token = getToken();
    if (!token) {
      warn(
        "No UEF token found. uef-boot.html should store it in localStorage under",
        CFG.tokenStorageKeyPrimary,
        "(fallback:",
        CFG.tokenStorageKeyLegacy,
        ")"
      );
      return;
    }

    send({
      type: "authorization:authorize",
      token,
    });
  }

  function subscribeEvents() {
    // We use route events to detect when the user clicked our Base Nav entry.
    // Portal events are useful to track panel lifecycle.
    send({
      type: "event:subscribe",
      subscriptions: ["route", "portal:new", "portal:remove"],
    });
  }

  function registerHelpProvider() {
    if (helpRegistered) return;

    send({
      type: "help:register",
      id: CFG.helpProviderId,
      displayName: CFG.displayName,
      providerType: CFG.helpProviderType,
      iconUrl: CFG.helpIconUrl,
    });
  }

  function registerBaseNavigationRoute() {
    if (baseNavRegistered) return;

    // NOTE:
    // The UEF docs' example request shows `contents` as a Link element with top-level
    // `to`, not nested under `props`.
    // See: IBaseNavigationRegistrationRequest example.
    send({
      type: "basenav:register",
      displayName: CFG.displayName,
      routeName: CFG.baseNavRouteName,

      // What appears in the left nav (keep this simple so it renders as text).
      contents: {
        tag: "Link",
        to: CFG.baseNavRouteName,
        children: CFG.displayName,
      },

      // What shows in the main content area if Ultra navigates to this route.
      // We still primarily use a right-side portal panel for the actual widget.
      initialContents: {
        tag: "div",
        children: "Opening Ask Mappy…",
      },
    });
  }

  // ------------------------------
  // Portal panel
  // ------------------------------
  function openWidgetPanel(reason) {
    if (activePortalId || openInProgress) return;
    openInProgress = true;

    send({
      type: "portal:panel",
      title: CFG.displayName,
      size: CFG.portalSize,
      element: {
        tag: "iframe",
        props: {
          src: CFG.widgetUrl,
          style: {
            width: "100%",
            height: "100%",
            border: "0",
          },
        },
      },
      onClose: {
        type: "portal:callback",
        callbackId: "mappy-panel-closed",
        data: { reason: reason || "unknown" },
      },
    });
  }

  // ------------------------------
  // Message handlers
  // ------------------------------
  function handleRouteEvent(msg) {
    // Route event shape per docs:
    // { type:'event:event', eventType:'route', routeName:'...', routeData:{...} }
    if (msg && msg.routeName === CFG.baseNavRouteName) {
      log("Base nav route activated; opening panel.");
      openWidgetPanel("base-nav");
    }
  }

  function handleHelpRequest(msg) {
    // Help request is correlated; must respond with help:request:response and the correlationId.
    // Docs: IHelpProviderRequest and IHelpProviderResponse.
    if (msg && msg.correlationId) {
      send({
        type: "help:request:response",
        correlationId: msg.correlationId,
      });
    }

    openWidgetPanel("help-menu");
  }

  function onPortMessage(event) {
    const msg = event.data;
    if (!msg) return;

    log("←", msg);

    // 1) Authorization success response
    // In Learn Ultra, the authorize response comes back with type: 'authorization:authorize'.
    if (msg.type === "authorization:authorize") {
      authorized = true;
      subscribeEvents();
      registerHelpProvider();
      registerBaseNavigationRoute();
      return;
    }

    // 2) Help provider registration response
    if (msg.type === "help:register") {
      helpRegistered = msg.status === "success";
      if (helpRegistered) {
        log(
          `Help provider registered as "${CFG.displayName}" (${CFG.helpProviderType}).`
        );
      } else {
        warn("Help provider registration failed", msg);
      }
      return;
    }

    // 3) Base nav registration response
    if (msg.type === "basenav:register") {
      baseNavRegistered = msg.status === "success";
      if (baseNavRegistered) {
        log('Base navigation entry registered as "' + CFG.displayName + '".');
      } else {
        warn("Base navigation registration failed", msg);
      }
      return;
    }

    // 4) Route / help events (arrive as event:event)
    if (msg.type === "event:event") {
      if (msg.eventType === "route") {
        handleRouteEvent(msg);
      }

      if (msg.eventType === "help:request") {
        handleHelpRequest(msg);
      }

      // Portal lifecycle events (optional; useful for debugging)
      if (msg.eventType === "portal:new") {
        // nothing required
      }

      if (msg.eventType === "portal:remove") {
        // If Ultra removes the portal without a callback, clear our state.
        if (activePortalId && msg.portalId === activePortalId) {
          activePortalId = null;
        }
      }

      return;
    }

    // 5) Some environments send help requests as direct message types.
    if (msg.type === "help:request") {
      handleHelpRequest(msg);
      return;
    }

    // 6) Portal responses/callbacks
    if (msg.type === "portal:panel:response") {
      openInProgress = false;
      if (msg.portalId) activePortalId = msg.portalId;
      return;
    }

    if (msg.type === "portal:callback") {
      if (msg.callbackId === "mappy-panel-closed") {
        activePortalId = null;
        openInProgress = false;
      }
      return;
    }
  }

  // ------------------------------
  // Handshake: get MessagePort from Ultra
  // ------------------------------
  function onWindowMessage(event) {
    const msg = event.data;
    if (!msg || msg.type !== "integration:hello") return;

    if (!event.ports || !event.ports[0]) {
      warn("integration:hello received but no MessagePort was provided.");
      return;
    }

    messagePort = event.ports[0];
    messagePort.onmessage = onPortMessage;

    log("Handshake received; using provided MessagePort.");

    // Kick off authorization.
    authorize();
  }

  window.addEventListener("message", onWindowMessage, false);

  // Start handshake. Use inferred Learn origin where possible.
  const learnOrigin = inferLearnOrigin();
  window.parent.postMessage({ type: "integration:hello" }, learnOrigin);
})();
