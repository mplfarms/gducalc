// src/ui/fileSave.js
//
// "Get this blob out of the browser" helpers. Copied from Corn Plot
// Harvest and trimmed to the two this app uses — its multi-file share
// and mailto helpers have no caller here.

import { showToast } from "./components/toast.js";

/**
 * Triggers a normal browser download via a temporary <a download> click.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Prefers the native Web Share sheet (with a file attachment) when
 * available; falls back to a plain download with an on-screen note.
 * @param {Blob} blob
 * @param {string} filename
 * @param {string} mime
 * @param {{title?: string, text?: string}} [opts] `text` rides along in
 *   the share sheet, so a message app gets the headline numbers in the
 *   body with the PDF attached rather than a bare attachment.
 * @returns {Promise<"shared"|"downloaded"|"cancelled">}
 */
export async function shareOrDownload(blob, filename, mime, opts) {
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: (opts && opts.title) || filename, text: opts && opts.text });
        return "shared";
      } catch (e) {
        if (e && e.name === "AbortError") return "cancelled";
        // fall through to download fallback on any other share failure
      }
    }
  } catch (e) {
    // File/share construction failed — fall through to download.
  }
  downloadBlob(blob, filename);
  showToast("This device doesn't support the native share sheet — the file was downloaded instead.", {
    type: "info",
  });
  return "downloaded";
}
