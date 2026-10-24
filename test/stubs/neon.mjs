// Test-only stand-in used when the real package is not installed (offline sandbox).
export function neon() { throw new Error('neon stub: inject env.__sql in tests'); }
