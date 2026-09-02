// Shared Base64URL encode/decode, split out of jwt.ts so lib/signedToken.ts
// (the guild-request flow's capability tokens, specs/0015) doesn't duplicate
// it or depend on a module named for a different kind of token.

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function textToBase64Url(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

export function base64UrlToText(str: string): string {
  return new TextDecoder().decode(base64UrlDecode(str));
}
