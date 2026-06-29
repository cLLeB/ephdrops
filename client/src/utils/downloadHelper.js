/**
 * Universal file download helper
 *
 * Handles file downloads across all platforms:
 *   1. Capacitor native app → @capacitor/share (share sheet → "Save to Files" / "Save Image")
 *   2. Mobile web (Chrome Android / Safari) → navigator.share with File
 *   3. Desktop browser → <a download> click
 *
 * The key problem: Android WebView (Capacitor) does NOT support the `download`
 * attribute on <a> elements, so `a.click()` silently fails. We must use the
 * native Share plugin to let the OS handle the file.
 */

import { isCapacitor, isMobile, isTauri } from './platform';
import { toast } from 'react-toastify';

/**
 * Download / save a file on any platform.
 *
 * @param {Blob} blob       - The file data as a Blob
 * @param {string} fileName - Suggested file name (e.g. "photo.jpg")
 * @param {string} [mimeType] - Optional MIME type override
 */
export async function downloadFileOnDevice(blob, fileName, mimeType) {
  const type = mimeType || blob.type || 'application/octet-stream';

  // ── Strategy 1: Capacitor native share ──────────────────
  // Write to Cache (no permissions needed on any Android/iOS version), then
  // open the OS share sheet so the user can "Save to Files" / "Save Image".
  // Directory.Documents requires WRITE_EXTERNAL_STORAGE which is blocked on
  // Android 11+ and explicitly removed from our manifest.
  if (isCapacitor) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');

      const base64Data = await blobToBase64(blob);
      const safeFileName = fileName || 'download';

      const writeResult = await Filesystem.writeFile({
        path: safeFileName,
        data: base64Data,
        directory: Directory.Cache,
      });

      await Share.share({
        title: safeFileName,
        url: writeResult.uri,
        dialogTitle: `Save ${safeFileName}`,
      });

      return true;
    } catch (capErr) {
      if (
        capErr?.message?.toLowerCase().includes('cancel') ||
        capErr?.message?.toLowerCase().includes('share was canceled') ||
        capErr?.errorMessage?.toLowerCase().includes('cancel')
      ) {
        return true; // user dismissed share sheet — not an error
      }
      console.warn('[downloadHelper] Capacitor path failed:', capErr.message);
      // Fall through to web share / <a> as last resort
    }
  }

  // ── Strategy 2: Tauri desktop — native save dialog ─────────
  // WebView2 on Windows silently drops <a download> clicks, so we use the
  // Rust `save_file_dialog` command which opens a native OS save dialog.
  if (isTauri) {
    try {
      const invoke = window.__TAURI__?.core?.invoke
        ?? window.__TAURI__?.invoke
        ?? window.__TAURI_INTERNALS__?.invoke;

      if (invoke) {
        const base64Data = await blobToBase64(blob);
        const result = await invoke('save_file_dialog', { base64Data, fileName });
        if (result?.success) {
          toast.success(`Saved: ${fileName}`);
          return true;
        }
        if (result?.error && result.error !== 'cancelled') {
          console.warn('[downloadHelper] Tauri save_file_dialog error:', result.error);
        }
        return true; // cancelled or saved — don't fall through
      }
    } catch (tauriErr) {
      console.warn('[downloadHelper] Tauri path failed:', tauriErr.message);
      // Fall through to <a> as last resort
    }
  }

  // ── Strategy 3: Web Share API with file (mobile browsers) ──
  if (isMobile && navigator.share && navigator.canShare) {
    try {
      const file = new File([blob], fileName, { type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: fileName });
        return true;
      }
    } catch (shareError) {
      if (shareError.name === 'AbortError') return false; // user cancelled
      console.warn('[downloadHelper] navigator.share failed:', shareError.message);
      // Fall through to <a> fallback
    }
  }

  // ── Strategy 4: Desktop fallback — <a download> click ──
  const url = URL.createObjectURL(new Blob([blob], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 5000);

  return true;
}

/**
 * Download / save a file from a data URL (base64 string like "data:image/png;base64,...")
 *
 * @param {string} dataUrl  - The data URL string
 * @param {string} fileName - Suggested file name
 */
export async function downloadDataUrlOnDevice(dataUrl, fileName) {
  // Convert data URL to Blob
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return downloadFileOnDevice(blob, fileName, blob.type);
}

/**
 * Download / save a file from an object URL (blob:http://...)
 *
 * @param {string} objectUrl - The blob URL
 * @param {string} fileName  - Suggested file name
 * @param {string} [mimeType] - Optional MIME type
 */
export async function downloadObjectUrlOnDevice(objectUrl, fileName, mimeType) {
  const response = await fetch(objectUrl);
  const blob = await response.blob();
  return downloadFileOnDevice(blob, fileName, mimeType || blob.type);
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Convert a Blob to a pure base64 string (no data: prefix)
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // reader.result is "data:<mime>;base64,XXXX"
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
