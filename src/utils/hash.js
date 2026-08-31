export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function combineHashes(hashes) {
  // Keep the resource hash order-independent, but preserve duplicate files:
  // [A,A,B] must not collapse to [A,B].
  const sorted = [...hashes].sort();
  const encoded = new TextEncoder().encode(sorted.join('|'));
  return sha256Hex(encoded);
}

export function normalizeCode(code) {
  return (code || '').toString().toUpperCase().replace(/[\s\-_]+/g, '').trim();
}

export function normalizeText(text) {
  return (text || '').toString().toLowerCase().trim().replace(/\s+/g, ' ');
}
