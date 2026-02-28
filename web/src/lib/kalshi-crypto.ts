import { get, set, del } from "idb-keyval";

// ── IndexedDB persistence for CryptoKey ────────────────────────────────

const CRYPTO_KEY_STORE = "kalshi-crypto-key";

export async function storeCryptoKey(key: CryptoKey): Promise<void> {
  await set(CRYPTO_KEY_STORE, key);
}

export async function loadCryptoKey(): Promise<CryptoKey | undefined> {
  return get<CryptoKey>(CRYPTO_KEY_STORE);
}

export async function clearCryptoKey(): Promise<void> {
  await del(CRYPTO_KEY_STORE);
}

// ── localStorage persistence for Key ID ────────────────────────────────

const KEY_ID_STORE = "kalshi-key-id";

export function storeKeyId(keyId: string): void {
  localStorage.setItem(KEY_ID_STORE, keyId);
}

export function loadKeyId(): string | null {
  return localStorage.getItem(KEY_ID_STORE);
}

export function clearKeyId(): void {
  localStorage.removeItem(KEY_ID_STORE);
}

// ── Check if keys are configured ───────────────────────────────────────

export async function hasKalshiKeys(): Promise<boolean> {
  const keyId = loadKeyId();
  if (!keyId) return false;
  const cryptoKey = await loadCryptoKey();
  return !!cryptoKey;
}

// ── PEM parsing and WebCrypto import ───────────────────────────────────

/**
 * Import a PEM private key string into WebCrypto as a non-extractable CryptoKey.
 * Supports both PKCS#8 ("BEGIN PRIVATE KEY") and PKCS#1 ("BEGIN RSA PRIVATE KEY") formats.
 */
export async function importPemKey(pemText: string): Promise<CryptoKey> {
  const { der, format } = parsePem(pemText);

  // WebCrypto only supports PKCS#8. Convert PKCS#1 if needed.
  const pkcs8Der = format === "pkcs1" ? pkcs1ToPkcs8(der) : der;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(pkcs8Der) as unknown as ArrayBuffer,
    { name: "RSA-PSS", hash: "SHA-256" },
    false, // non-extractable — key material cannot be read back
    ["sign"]
  );

  return cryptoKey;
}

/**
 * Parse PEM text into DER bytes + detected format.
 */
function parsePem(pem: string): { der: Uint8Array; format: "pkcs8" | "pkcs1" } {
  const lines = pem.trim().split("\n");
  const header = lines[0].trim();

  let format: "pkcs8" | "pkcs1";
  if (header.includes("BEGIN PRIVATE KEY")) {
    format = "pkcs8";
  } else if (header.includes("BEGIN RSA PRIVATE KEY")) {
    format = "pkcs1";
  } else {
    throw new Error(
      `Unsupported PEM format. Expected "BEGIN PRIVATE KEY" (PKCS#8) or "BEGIN RSA PRIVATE KEY" (PKCS#1), got: ${header}`
    );
  }

  // Strip header/footer lines and decode base64
  const b64 = lines
    .filter((line) => !line.startsWith("-----"))
    .join("")
    .replace(/\s/g, "");

  const binary = atob(b64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    der[i] = binary.charCodeAt(i);
  }

  return { der, format };
}

/**
 * Wrap a PKCS#1 RSA private key DER in a PKCS#8 envelope.
 *
 * PKCS#8 structure:
 *   SEQUENCE {
 *     INTEGER 0                            -- version
 *     SEQUENCE {                           -- algorithmIdentifier
 *       OID 1.2.840.113549.1.1.1          -- rsaEncryption
 *       NULL                              -- parameters
 *     }
 *     OCTET STRING {                      -- privateKey
 *       <pkcs1_der_bytes>
 *     }
 *   }
 */
function pkcs1ToPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  // Version: INTEGER 0
  const version = new Uint8Array([0x02, 0x01, 0x00]);

  // AlgorithmIdentifier: SEQUENCE { OID rsaEncryption, NULL }
  const algorithmId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);

  // OCTET STRING wrapping the PKCS#1 key
  const octetStringHeader = derEncode(0x04, pkcs1Der.length);

  // Inner content length
  const innerLen =
    version.length +
    algorithmId.length +
    octetStringHeader.length +
    pkcs1Der.length;

  // Outer SEQUENCE
  const outerHeader = derEncode(0x30, innerLen);

  // Concatenate everything
  const result = new Uint8Array(outerHeader.length + innerLen);
  let offset = 0;

  result.set(outerHeader, offset);
  offset += outerHeader.length;
  result.set(version, offset);
  offset += version.length;
  result.set(algorithmId, offset);
  offset += algorithmId.length;
  result.set(octetStringHeader, offset);
  offset += octetStringHeader.length;
  result.set(pkcs1Der, offset);

  return result;
}

/**
 * Encode a DER tag + length prefix.
 * Handles short form (< 128) and long form (up to 65535).
 */
function derEncode(tag: number, length: number): Uint8Array {
  if (length < 128) {
    return new Uint8Array([tag, length]);
  } else if (length < 256) {
    return new Uint8Array([tag, 0x81, length]);
  } else {
    return new Uint8Array([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
  }
}

// ── Request signing ────────────────────────────────────────────────────

/**
 * Sign a Kalshi API request using RSA-PSS with SHA-256.
 * Matches the Rust implementation: message = `{timestamp}{method}{path}`
 *
 * @param key - The CryptoKey stored in IndexedDB
 * @param timestampMs - Current time in milliseconds as a string
 * @param method - HTTP method (e.g., "GET", "POST")
 * @param path - The API path WITHOUT query params (e.g., "/trade-api/v2/markets")
 * @returns Base64-encoded signature
 */
export async function signKalshiRequest(
  key: CryptoKey,
  timestampMs: string,
  method: string,
  path: string
): Promise<string> {
  const message = `${timestampMs}${method}${path}`;
  const encoded = new TextEncoder().encode(message);

  const signatureBuffer = await crypto.subtle.sign(
    {
      name: "RSA-PSS",
      saltLength: 32, // SHA-256 digest size = 32 bytes
    },
    key,
    encoded
  );

  // Convert ArrayBuffer to base64
  const signatureBytes = new Uint8Array(signatureBuffer);
  let binary = "";
  for (let i = 0; i < signatureBytes.length; i++) {
    binary += String.fromCharCode(signatureBytes[i]);
  }
  return btoa(binary);
}
