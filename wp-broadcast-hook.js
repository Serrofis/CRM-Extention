(() => {
  if (window.__wpBroadcastPageHookInstalled) return;
  window.__wpBroadcastPageHookInstalled = true;
  // Loaded by the manifest as a MAIN-world content script (and possibly
  // also by the older <script src> injection; this guard makes the second
  // one a no-op). Leave a DOM marker the content script can see, so its
  // diagnostics can tell "hook not loaded" from "hook not answering".
  try { document.documentElement.setAttribute('data-wp-broadcast-hook', '1'); } catch (_) {}

  const SOURCE = 'wp-transfer-assistant-broadcast-hook';
  let autoConfirmUntil = 0;
  let armedUntil = 0;
  let completionEmitted = false;
  let bindAttempts = 0;
  let ajaxWrapped = false;

  function post(type, extra) {
    try {
      window.postMessage(Object.assign({
        source: SOURCE,
        type
      }, extra || {}), window.location.origin);
    } catch (_) {}
  }


  function requestText(url, data) {
    try {
      let body = '';
      if (typeof data === 'string') {
        body = decodeURIComponent(data.replace(/\+/g, ' '));
      } else if (data && typeof data === 'object') {
        if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
          body = data.toString();
        } else {
          body = JSON.stringify(data);
        }
      }
      return (String(url || '') + ' ' + body).toLowerCase();
    } catch (_) {
      return String(url || '').toLowerCase();
    }
  }

  function isOneStepRequest(url, data) {
    if (!/\/generate_suggestions(?:[/?#]|$)/i.test(String(url || ''))) return false;

    // The CRM source uses a JavaScript object for $.ajax({ data: {...} }),
    // not a URL-encoded string. Read that exact object first.
    if (data && typeof data === 'object' && !(data instanceof URLSearchParams)) {
      return String(data.type || '').trim() === '1_step_broadcast';
    }

    const text = requestText(url, data);
    return /(?:^|[\s&?{,"'])type(?:\s*[:=])\s*["']?1_step_broadcast["']?(?:&|\s|[,}\s]|$)/i.test(text);
  }

  function arm() {
    armedUntil = Date.now() + 30000;
    completionEmitted = false;
  }

  function emitStarted(status, source) {
    if (completionEmitted) return;
    if (Date.now() > armedUntil) return;
    completionEmitted = true;
    post('one-step-broadcast-started', {
      status: Number(status || 200),
      source: source || 'ajax'
    });
  }

  function emitError(status, source) {
    if (completionEmitted) return;
    if (Date.now() > armedUntil) return;
    completionEmitted = true;
    post('one-step-broadcast-error', {
      status: Number(status || 0),
      source: source || 'ajax'
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data || {};
    if (data.source !== 'wp-transfer-assistant') return;

    if (data.type === 'ping') {
      post('pong');
    }

    if (data.type === 'batch-auto-confirm-one-step') {
      autoConfirmUntil = Date.now() + 30000;
      arm();
      // Let the content script know confirm() is now auto-accepted, so it
      // clicks only after this point (postMessage is asynchronous).
      post('auto-confirm-armed');
    }

    if (data.type === 'trigger-one-step-broadcast') {
      arm();
      try {
        const button = document.querySelector(
          'a.generate-suggestions[data-type="1_step_broadcast"]'
        );
        if (!button) {
          post('one-step-broadcast-error', { status: 0, source: 'trigger', reason: 'button-not-found' });
          return;
        }

        watchGenerateSuggestionsRequest(performance.now());

        // A real DOM click, exactly like the operator's mouse click. It
        // bubbles to document, where the CRM's delegated
        //   $(document).on("click", "a.generate-suggestions", ...)
        // handler calls generateSuggestions($(this).data("type")).
        // jq(button).trigger('click') was not reliable here: for <a> elements
        // jQuery never fires the native click, it only runs handlers bound
        // through that same jQuery copy, so if the CRM's handler lives on a
        // different jQuery instance than window.jQuery nothing happens.
        button.click();
      } catch (_) {
        post('one-step-broadcast-error', { status: 0, source: 'trigger', reason: 'native-click-threw' });
      }
    }
  });

  // Detect the POST /generate_suggestions from the browser's own resource
  // timing, which sees every XHR no matter which jQuery instance sent it.
  // Uses a PerformanceObserver (not getEntries) so a full resource-timing
  // buffer on a long-lived CRM page can't hide the entry. The jQuery
  // done/ajaxSuccess hooks below stay as they are; whichever reports first
  // wins (completionEmitted), so nothing is reported twice.
  function watchGenerateSuggestionsRequest(since) {
    if (typeof PerformanceObserver !== 'function') return;
    let observer = null;
    const stop = function() {
      try { if (observer) observer.disconnect(); } catch (_) {}
      observer = null;
    };
    try {
      observer = new PerformanceObserver(function(list) {
        if (completionEmitted || Date.now() > armedUntil) { stop(); return; }
        const hit = list.getEntries().find(function(entry) {
          return entry.startTime >= since - 50 &&
            /\/generate_suggestions(?:[/?#]|$)/i.test(String(entry.name || '')) &&
            entry.responseEnd > 0;
        });
        if (!hit) return;
        stop();
        const status = Number(hit.responseStatus || 0);
        if (status >= 400) emitError(status, 'resource-timing');
        else emitStarted(status || 200, 'resource-timing');
      });
      observer.observe({ type: 'resource', buffered: false });
      setTimeout(stop, 31000);
    } catch (_) {
      stop();
    }
  }

  // The CRM's broadcast action is a delegated jQuery click handler. Wrap
  // confirm only for an explicitly armed assistant broadcast, so unrelated
  // confirmations remain untouched.
  const nativeConfirm = window.confirm;
  if (typeof nativeConfirm === 'function' && !window.__wpBroadcastConfirmWrapped) {
    window.__wpBroadcastConfirmWrapped = true;
    window.confirm = function (...args) {
      const auto = Date.now() <= autoConfirmUntil && Date.now() <= armedUntil;
      const result = auto ? true : nativeConfirm.apply(window, args);
      if (auto) autoConfirmUntil = 0;
      return result;
    };
  }

  function bindJQuery() {
    bindAttempts += 1;
    const jq = window.jQuery;
    if (jq && jq.fn && !ajaxWrapped) {
      const originalAjax = jq.ajax;
      if (typeof originalAjax === 'function') {
        jq.ajax = function(url, settings) {
          let requestUrl = url;
          let requestSettings = settings;
          if (url && typeof url === 'object') {
            requestSettings = url;
            requestUrl = requestSettings.url;
          }

          const data = requestSettings && requestSettings.data;
          const oneStep = isOneStepRequest(requestUrl, data) && Date.now() <= armedUntil;
          const xhr = originalAjax.apply(this, arguments);

          if (oneStep && xhr) {
            try {
              // IMPORTANT: xhr here is the jqXHR object returned by $.ajax().
              // It already implements the Promise/Deferred interface (.done()/
              // .fail() are methods on the jqXHR itself), so it must be used
              // directly. Wrapping it as jq(xhr) creates a plain jQuery
              // collection containing the object, which has no .done()/.fail()
              // methods and previously threw silently (swallowed by this
              // try/catch), relying entirely on the ajaxSuccess/ajaxError
              // fallback below to ever report completion.
              xhr.done(function() {
                emitStarted(xhr.status || 200, 'jquery.ajax.done');
              }).fail(function() {
                emitError(xhr.status || 0, 'jquery.ajax.fail');
              });
            } catch (_) {}
          }

          return xhr;
        };
        ajaxWrapped = true;
      }
    }

    // Keep a secondary event observer for CRM builds where jq.ajax is replaced
    // after startup. It uses the same exact request predicate.
    if (jq && jq.fn && !jq(document).data('wpTransferBroadcastEventBound')) {
      jq(document).data('wpTransferBroadcastEventBound', true);
      jq(document).on('ajaxSuccess.wpTransferBroadcast', (_event, xhr, settings) => {
        if (Date.now() > armedUntil) return;
        if (!isOneStepRequest(settings && settings.url, settings && settings.data)) return;
        emitStarted(xhr && xhr.status ? xhr.status : 200, 'ajaxSuccess');
      });
      jq(document).on('ajaxError.wpTransferBroadcast', (_event, xhr, settings) => {
        if (Date.now() > armedUntil) return;
        if (!isOneStepRequest(settings && settings.url, settings && settings.data)) return;
        emitError(xhr && xhr.status ? xhr.status : 0, 'ajaxError');
      });
    }

    if (bindAttempts < 120 && (!jq || !jq.fn || !ajaxWrapped)) {
      setTimeout(bindJQuery, 250);
    }
  }

  bindJQuery();
})();
