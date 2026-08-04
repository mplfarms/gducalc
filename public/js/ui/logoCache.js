// src/ui/logoCache.js
//
// Fetches a brand logo PNG once and caches it as a data URL, for use in
// jsPDF's doc.addImage() (which needs a data URL or raw bytes, not a
// bare image path).

/** @type {Map<string, Promise<string>>} */
const cache = new Map();

/**
 * @param {{logo: string}} brand
 * @returns {Promise<string>} data URL
 */
export function getLogoDataUrl(brand) {
  const key = brand.logo;
  if (cache.has(key)) return cache.get(key);

  const promise = fetch(key)
    .then((r) => r.blob())
    .then(
      (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error("Failed to read logo image"));
          reader.readAsDataURL(blob);
        })
    );

  cache.set(key, promise);
  return promise;
}
