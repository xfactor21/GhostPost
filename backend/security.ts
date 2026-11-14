import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

export type TokenData = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};
export type Envelope = { ciphertext: string; iv: string; tag: string };
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const nonce = () => randomBytes(32).toString("base64url");
export function parseKey(raw: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw new Error("Secure token storage is unavailable.");
  return Buffer.from(raw, "hex");
}
export function encrypt(payload: TokenData, key: Buffer): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: data.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
export function parseToken(payload: unknown): TokenData {
  if (!payload || typeof payload !== "object")
    throw new Error("Invalid token response.");
  const data = payload as Record<string, unknown>;
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    data.access_token.length > 24000
  )
    throw new Error("Invalid token response.");
  return {
    access_token: data.access_token,
    ...(typeof data.refresh_token === "string" &&
    data.refresh_token.length <= 24000
      ? { refresh_token: data.refresh_token }
      : {}),
    ...(typeof data.expires_in === "number" &&
    Number.isFinite(data.expires_in) &&
    data.expires_in > 0
      ? { expires_in: data.expires_in }
      : {}),
    ...(typeof data.scope === "string"
      ? { scope: data.scope.slice(0, 2048) }
      : {}),
  };
}
export function decrypt(envelope: Envelope, key: Buffer): TokenData {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return parseToken(JSON.parse(plain.toString("utf8")));
}
export const needsRefresh = (
  expiresAt: number | null | undefined,
  now = Date.now(),
) => typeof expiresAt !== "number" || expiresAt <= now + 60000;
export function safeUrl(value: unknown, optional = false): string {
  if (optional && (value === "" || value === undefined || value === null))
    return "";
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("Enter a valid HTTPS destination URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid HTTPS destination URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname.includes(".")
  )
    throw new Error("Use an HTTPS URL without embedded credentials.");
  return url.href;
}
export function text(value: unknown, max: number, required = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new Error(`Enter ${required ? "1" : "0"}–${max} characters.`);
  return value.trim();
}
export function validId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error("Invalid record identifier.");
  return value;
}
export function plannedDate(value: unknown): string {
  if (!value) return "";
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Choose a valid date.");
  return new Date(value).toISOString();
}
