/**
 * Platform Utilities
 * Cross-platform helpers that leverage browser APIs available in
 * Web, Electron, and Capacitor environments.
 */

// ==================== HAPTIC FEEDBACK ====================

/**
 * Trigger haptic feedback using the Web Vibration API.
 * Works on Android (both browser + Capacitor). Silently no-ops on desktop/iOS.
 */
export function hapticLight() {
    if (navigator.vibrate) navigator.vibrate(10);
}

export function hapticMedium() {
    if (navigator.vibrate) navigator.vibrate(25);
}

export function hapticHeavy() {
    if (navigator.vibrate) navigator.vibrate(50);
}

export function hapticSuccess() {
    if (navigator.vibrate) navigator.vibrate([15, 50, 15]);
}

export function hapticError() {
    if (navigator.vibrate) navigator.vibrate([50, 30, 50, 30, 50]);
}

// ==================== SCREEN WAKE LOCK ====================

let wakeLock = null;

/**
 * Request a screen wake lock (prevents screen from sleeping).
 * Useful during audio/video calls.
 * Uses the Screen Wake Lock API — supported in Chrome, Edge, Capacitor WebView.
 */
export async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => {
                wakeLock = null;
            });
            console.log('🔆 Screen wake lock acquired');
            return true;
        }
    } catch (err) {
        console.warn('Wake lock request failed:', err);
    }
    return false;
}

/**
 * Release the screen wake lock.
 */
export async function releaseWakeLock() {
    if (wakeLock) {
        try {
            await wakeLock.release();
            wakeLock = null;
            console.log('🌙 Screen wake lock released');
        } catch (err) {
            console.warn('Wake lock release failed:', err);
        }
    }
}

/**
 * Re-acquire wake lock when tab becomes visible again (it auto-releases on hide).
 */
export function setupWakeLockReacquire() {
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && wakeLock === null) {
            // Check if we should re-acquire (caller sets a flag)
            if (window.__wakeLockActive) {
                await requestWakeLock();
            }
        }
    });
}

// ==================== PLATFORM DETECTION ====================

export const isElectron = !!(window.electronAPI?.isElectron);
export const isCapacitor = !!(window.Capacitor?.isNativePlatform?.());
export const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
export const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
export const isAndroid = /Android/i.test(navigator.userAgent);
export const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

// ==================== SECURITY CAPABILITY DETECTION ====================

/** True when the browser/WebView supports WebCrypto (SubtleCrypto) */
export const hasWebCrypto = !!(globalThis.crypto?.subtle);

/** True when WebTransport is available (Chromium 113+, NOT Android WebView) */
export const hasWebTransport = typeof globalThis.WebTransport !== 'undefined';

/** True when Electron exposes security IPC bridge */
export const hasElectronSecurity = !!(window.electronAPI?.security);

/**
 * Get a summary of which security features are available on the current platform.
 * Useful for diagnostics and deciding which fallback paths to take.
 */
export function getSecurityCapabilities() {
  return {
    platform: isElectron ? 'electron' : isCapacitor ? 'capacitor' : 'web',
    webCrypto: hasWebCrypto,
    webTransport: hasWebTransport,
    electronSecurity: hasElectronSecurity,
    // SharedArrayBuffer is needed by some WASM crypto modules
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    // WebAssembly is needed for native crypto implementations
    wasm: typeof WebAssembly !== 'undefined',
  };
}

// Initialize wake lock re-acquire handler
setupWakeLockReacquire();
