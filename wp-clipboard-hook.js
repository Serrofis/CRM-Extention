(function () {
    'use strict';

    if (window.__wpNativeTransferClipboardHookInstalled) return;
    window.__wpNativeTransferClipboardHookInstalled = true;

    function looksLikeTransferDetails(text) {
        const value = String(text || '').replace(/\r\n/g, '\n').trim();
        if (!value) return false;

        const hasDayOrDate = /\b(?:today|tomorrow|mon|tue|wed|thu|fri|sat|sun)\b|\b\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?\b/i.test(value);
        const hasTime = /\b\d{1,2}:\d{2}\b/.test(value);
        const hasPaxLug = /\bPax\s*\/\s*Lug\s*:/i.test(value);
        const hasRoute = /\s(?:->|→|to)\s/i.test(value);

        return hasPaxLug || (hasDayOrDate && hasTime && hasRoute) || (hasDayOrDate && hasTime && value.split(/\n/).filter(Boolean).length >= 3);
    }

    function emit(text) {
        const value = String(text == null ? '' : text).trim();
        if (!looksLikeTransferDetails(value)) return;

        try {
            window.postMessage({
                source: 'wp-transfer-assistant-page-hook',
                type: 'NATIVE_TRANSFER_CLIPBOARD',
                text: value
            }, '*');
        } catch (_) {}
    }

    // Most reliable path for legacy CRM copy handlers: the browser exposes
    // the exact text being copied through the ClipboardEvent itself. This
    // works even when the CRM does not call navigator.clipboard.writeText().
    function captureCopyEvent(event) {
        try {
            const clipboardData = event && event.clipboardData;
            const value = clipboardData
                ? clipboardData.getData('text/plain')
                : '';
            if (value) emit(value);
        } catch (_) {}

        // Some handlers populate clipboardData during the event and the
        // selection/default action finishes one tick later.
        try {
            const selected = String(
                window.getSelection ? window.getSelection().toString() : ''
            ).trim();
            if (selected) emit(selected);
        } catch (_) {}

        setTimeout(function() {
            try {
                const selected = String(
                    window.getSelection ? window.getSelection().toString() : ''
                ).trim();
                if (selected) emit(selected);
            } catch (_) {}
        }, 0);
    }

    document.addEventListener('copy', captureCopyEvent, true);
    document.addEventListener('copy', captureCopyEvent, false);

    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
            navigator.clipboard.writeText = function (text) {
                emit(text);
                return originalWriteText(text);
            };
        }
    } catch (_) {}

    try {
        if (navigator.clipboard && typeof navigator.clipboard.write === 'function') {
            const originalWrite = navigator.clipboard.write.bind(navigator.clipboard);
            navigator.clipboard.write = async function (items) {
                try {
                    const list = Array.from(items || []);
                    for (const item of list) {
                        const types = Array.from(item && item.types || []);
                        if (types.includes('text/plain') && item.getType) {
                            try {
                                const blob = await item.getType('text/plain');
                                emit(await blob.text());
                            } catch (_) {}
                        }
                    }
                } catch (_) {}
                return originalWrite(items);
            };
        }
    } catch (_) {}

    try {
        const originalExecCommand = document.execCommand.bind(document);
        document.execCommand = function (command) {
            if (String(command || '').toLowerCase() === 'copy') {
                try {
                    const selected = String(window.getSelection ? window.getSelection().toString() : '').trim();
                    emit(selected);
                } catch (_) {}
            }
            return originalExecCommand.apply(document, arguments);
        };
    } catch (_) {}

    // Fallback for Chromium builds that expose Clipboard.prototype methods as
    // non-own properties on navigator.clipboard. Patch the prototype when it
    // is safely writable; failures are intentionally ignored.
    try {
        const clipboard = navigator.clipboard;
        const prototype = clipboard && Object.getPrototypeOf(clipboard);
        if (prototype && typeof prototype.writeText === 'function') {
            const original = prototype.writeText;
            if (!original.__wpTransferAssistantWrapped) {
                const wrapped = function(text) {
                    emit(text);
                    return original.apply(this, arguments);
                };
                wrapped.__wpTransferAssistantWrapped = true;
                Object.defineProperty(prototype, 'writeText', {
                    configurable: true, writable: true, value: wrapped
                });
            }
        }
        if (prototype && typeof prototype.write === 'function') {
            const originalWrite = prototype.write;
            if (!originalWrite.__wpTransferAssistantWrapped) {
                const wrappedWrite = async function(items) {
                    try {
                        for (const item of Array.from(items || [])) {
                            const types = Array.from(item && item.types || []);
                            if (types.includes('text/plain') && item.getType) {
                                const blob = await item.getType('text/plain');
                                emit(await blob.text());
                            }
                        }
                    } catch (_) {}
                    return originalWrite.apply(this, arguments);
                };
                wrappedWrite.__wpTransferAssistantWrapped = true;
                Object.defineProperty(prototype, 'write', {
                    configurable: true, writable: true, value: wrappedWrite
                });
            }
        }
    } catch (_) {}
})();
