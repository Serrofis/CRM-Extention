// Welcome Pickups Transfer Assistant — WhatsApp Web, page world (1.7.154)
//
// WhatsApp Web asks "Leave site? Changes you made may not be saved." when
// the page is left. When the extension itself moves the tab to a group /
// chat link, wp-whatsapp.js first marks the page
// (<html data-wp-wa-navigating="1">); only then are WhatsApp's warning
// handlers skipped. Leaving the page yourself (closing, reloading) is
// unchanged. Loaded at document_start (before WhatsApp's own code) and, for
// tabs opened earlier, added by the extension when it needs the tab.
(function() {
    'use strict';
    if (window.__wpWaLeaveGuard) return;
    window.__wpWaLeaveGuard = true;

    const skip = function() {
        const root = document.documentElement;
        return Boolean(root && root.getAttribute('data-wp-wa-navigating') === '1');
    };

    // 1) First listener on window: stop every later "beforeunload" handler.
    window.addEventListener('beforeunload', function(event) {
        if (skip()) event.stopImmediatePropagation();
    }, true);

    // 2) Handlers WhatsApp adds from now on do nothing while marked.
    const originalAdd = EventTarget.prototype.addEventListener;
    const originalRemove = EventTarget.prototype.removeEventListener;
    const wrapped = new WeakMap();
    EventTarget.prototype.addEventListener = function(type, listener, options) {
        if (type === 'beforeunload' && this === window && listener) {
            let guarded = wrapped.get(listener);
            if (!guarded) {
                guarded = function(event) {
                    if (skip()) return undefined;
                    return typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
                };
                wrapped.set(listener, guarded);
            }
            return originalAdd.call(this, type, guarded, options);
        }
        return originalAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
        if (type === 'beforeunload' && this === window && listener && wrapped.has(listener)) {
            return originalRemove.call(this, type, wrapped.get(listener), options);
        }
        return originalRemove.call(this, type, listener, options);
    };

    // 3) window.onbeforeunload = … : kept, but skipped while marked.
    try {
        let handler = window.onbeforeunload || null;
        window.onbeforeunload = null;
        Object.defineProperty(window, 'onbeforeunload', {
            configurable: true,
            get: function() { return handler; },
            set: function(fn) { handler = typeof fn === 'function' ? fn : null; }
        });
        originalAdd.call(window, 'beforeunload', function(event) {
            if (skip() || typeof handler !== 'function') return;
            const result = handler.call(window, event);
            if (result !== undefined && result !== null) {
                event.preventDefault();
                event.returnValue = result;
            }
        });
    } catch (_) {}

    // 4) 1.7.285: Mute (the side panel's WhatsApp only — wp-whatsapp.js
    // marks <html data-wp-mute="1">): every sound WhatsApp plays is silent.
    const muted = function() {
        const root = document.documentElement;
        return Boolean(root && root.getAttribute('data-wp-mute') === '1');
    };
    try {
        // media we silenced (given back their sound when unmuted)
        const silenced = new Set();
        const silence = function(media) {
            if (!media || media.muted) return;
            media.muted = true;
            silenced.add(media);
        };
        const originalPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function() {
            if (muted()) silence(this);
            return originalPlay.apply(this, arguments);
        };
        // sounds made with Web Audio: their output goes through a gain that is 0 while muted
        const gains = [];
        if (window.AudioContext && window.AudioNode && window.AudioDestinationNode) {
            const byContext = new WeakMap();
            const originalConnect = AudioNode.prototype.connect;
            AudioNode.prototype.connect = function(target) {
                if (target instanceof AudioDestinationNode && this.context) {
                    let gain = byContext.get(this.context);
                    if (!gain) {
                        gain = this.context.createGain();
                        originalConnect.call(gain, this.context.destination);
                        gain.gain.value = muted() ? 0 : 1;
                        byContext.set(this.context, gain);
                        gains.push(gain);
                    }
                    const args = Array.prototype.slice.call(arguments);
                    args[0] = gain;
                    return originalConnect.apply(this, args);
                }
                return originalConnect.apply(this, arguments);
            };
        }
        const apply = function() {
            const on = muted();
            gains.forEach(function(gain) { try { gain.gain.value = on ? 0 : 1; } catch (_) {} });
            if (on) {
                document.querySelectorAll('audio, video').forEach(function(media) { if (!media.paused) silence(media); });
                silenced.forEach(function(media) { if (!media.isConnected && media.paused) silenced.delete(media); });
            } else {
                silenced.forEach(function(media) { try { media.muted = false; } catch (_) {} });
                silenced.clear();
            }
        };
        new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-wp-mute'] });
    } catch (_) {}
})();
