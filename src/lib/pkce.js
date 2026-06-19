/* ══════════════════════════════════════════════════════════════
   DERIVPRINTER — PKCE Utility
   Cryptographic helpers for OAuth 2.0 PKCE.
   ══════════════════════════════════════════════════════════════ */

/**
 * Generates PKCE parameters: code_verifier, code_challenge, and CSRF state string.
 * @returns {Promise<{codeVerifier: string, codeChallenge: string, state: string}>}
 */
export async function generatePKCE() {
  // 1. Generate a random code_verifier (43 - 128 characters)
  const array = crypto.getRandomValues(new Uint8Array(64));
  const codeVerifier = Array.from(array)
    .map(v => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[v % 66])
    .join('');

  // 2. Derive the code_challenge using SHA-256 and base64url encoding
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // 3. Generate a random state for CSRF protection
  const state = crypto.getRandomValues(new Uint8Array(16))
    .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

  return { codeVerifier, codeChallenge, state };
}
