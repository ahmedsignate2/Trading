// Signature des requêtes privées Coinbase Advanced Trade (JWT, comme le SDK officiel).
// Clés acceptées : ECDSA P-256 (PEM « EC PRIVATE KEY » ou « PRIVATE KEY ») et Ed25519 (base64).

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/\s+/g, "")), c => c.charCodeAt(0));
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Longueur DER (formes courte et longue). */
function derLen(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  if (n < 0x100) return Uint8Array.of(0x81, n);
  return Uint8Array.of(0x82, n >> 8, n & 0xff);
}
const der = (tag: number, body: Uint8Array) => concat(Uint8Array.of(tag), derLen(body.length), body);

/** Convertit une clé EC « SEC1 » (BEGIN EC PRIVATE KEY) en PKCS#8, le format lu par WebCrypto. */
function sec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  const algo = der(0x30, concat(
    Uint8Array.from([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]),        // id-ecPublicKey
    Uint8Array.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]),  // prime256v1
  ));
  return der(0x30, concat(Uint8Array.of(0x02, 0x01, 0x00), algo, der(0x04, sec1)));
}

interface LoadedKey { key: CryptoKey; alg: "ES256" | "EdDSA" }
const cache = new Map<string, Promise<LoadedKey>>();

async function loadKey(secret: string): Promise<LoadedKey> {
  const s = secret.replace(/\\n/g, "\n").trim();
  if (s.startsWith("-----BEGIN")) {
    const body = fromB64(s.replace(/-----[^-]+-----/g, ""));
    const pkcs8 = s.includes("EC PRIVATE KEY") ? sec1ToPkcs8(body) : body;
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return { key, alg: "ES256" };
  }
  const raw = fromB64(s);
  if (raw.length !== 32 && raw.length !== 64) throw new Error("Clé Coinbase illisible (ni PEM, ni Ed25519 base64)");
  const pkcs8 = concat(Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]), raw.slice(0, 32));
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { key, alg: "EdDSA" };
}

/** JWT valable 2 minutes pour une requête donnée (ex. "POST", "/api/v3/brokerage/orders"). */
export async function buildJwt(keyName: string, secret: string, method: string, path: string): Promise<string> {
  if (!cache.has(secret)) cache.set(secret, loadKey(secret));
  const { key, alg } = await cache.get(secret)!;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg, kid: keyName, nonce: hex(16), typ: "JWT" };
  const payload = { sub: keyName, iss: "cdp", nbf: now, exp: now + 120, uri: `${method} api.coinbase.com${path}` };
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const params = alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" };
  const sig = new Uint8Array(await crypto.subtle.sign(params, key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}
