/**
 * Unified cross-platform sharing / external-link helper.
 *
 * THE TAURI PROBLEM (and why this file exists):
 * --------------------------------------------------------------------------
 * Inside a Tauri WebView (WebView2 on Windows, WKWebView on macOS,
 * WebKitGTK on Linux) `window.open(url)` and `<a target="_blank">` are
 * SILENTLY SWALLOWED — the click appears to do nothing. The old ShareSheet
 * also probed `window.electronAPI.openUrlExternal`, which only exists under
 * Electron, never under Tauri — so the share buttons were dead.
 *
 * The tested, reliable fix is to NOT open URLs from JavaScript at all on
 * Tauri. Instead we hand the URL to the Rust side via the `open_external`
 * command, which uses the official `tauri-plugin-opener` to launch the URL
 * in the OS default handler (browser, mail client, WhatsApp/Telegram protocol
 * handler, …). Routing through Rust sidesteps every WebView quirk and JS-side
 * capability-scoping footgun.
 *
 * Resolution order per platform:
 *   - Tauri      → invoke('open_external')           (Rust opener plugin)
 *   - Capacitor  → @capacitor/share for share sheets, window.open for links
 *   - Web        → navigator.share when available, else window.open
 */

import { isTauri, isCapacitor, isMobile } from './platform';

/** Grab Tauri's invoke regardless of how globals are exposed. */
function getTauriInvoke() {
  return (
    window.__TAURI__?.core?.invoke ??
    window.__TAURI__?.invoke ??
    window.__TAURI_INTERNALS__?.invoke ??
    null
  );
}

/**
 * Open a URL (http/https/mailto/app-scheme) in the OS default handler.
 *
 * @param {string} url
 * @returns {Promise<boolean>} true when the open was dispatched
 */
export async function openExternal(url) {
  if (!url) return false;

  // ── Tauri desktop: route through Rust (window.open is swallowed) ──
  if (isTauri) {
    const invoke = getTauriInvoke();
    if (invoke) {
      try {
        const res = await invoke('open_external', { url });
        // Rust command returns { success, error? }; treat anything non-false as ok
        if (!res || res.success !== false) return true;
        console.warn('[share] open_external reported failure:', res.error);
      } catch (err) {
        console.warn('[share] open_external threw:', err?.message || err);
      }
    } else {
      console.warn('[share] Tauri detected but invoke() unavailable');
    }
    // If we reach here the Rust route failed — fall through to window.open as a
    // last resort (rarely works on Tauri, but better than swallowing silently).
  }

  // ── Web / Capacitor / fallback ──
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  // Capacitor's Android WebView returns null even when the navigation happens,
  // so treat Capacitor as success to avoid false-negative toasts.
  return !!opened || isCapacitor;
}

/**
 * Invoke a NATIVE share sheet for a link, where the platform provides one.
 * Returns false when no native sheet is available so the caller can fall back
 * to its own in-app share UI (the custom ShareSheet component).
 *
 * @param {{ url: string, text?: string, title?: string }} data
 * @returns {Promise<boolean>} true if a native share sheet handled it
 */
export async function shareLinkNative({ url, text, title }) {
  if (!url) return false;

  // ── Capacitor: real Android share sheet via @capacitor/share ──
  if (isCapacitor) {
    try {
      const { Share } = await import('@capacitor/share');
      const canShare = await Share.canShare();
      if (canShare?.value) {
        await Share.share({ title, text, url, dialogTitle: title || 'Share link' });
        return true;
      }
    } catch (err) {
      // User cancelled the sheet — treat as handled, don't fall back.
      const msg = (err?.message || err?.errorMessage || '').toLowerCase();
      if (msg.includes('cancel') || msg.includes('abort')) return true;
      console.warn('[share] Capacitor Share failed:', err?.message || err);
    }
    return false;
  }

  // ── Mobile web: Web Share API ──
  if (isMobile && navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return true;
    } catch (err) {
      if (err?.name === 'AbortError') return true; // user dismissed
      console.warn('[share] navigator.share failed:', err?.message || err);
    }
  }

  // No native sheet available (desktop web, Tauri) — caller shows custom sheet.
  return false;
}
