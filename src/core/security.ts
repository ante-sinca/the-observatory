import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const SENSITIVE_PATH_SEGMENTS = new Set([
  "secret",
  "secrets",
  "credential",
  "credentials",
  ".aws",
  ".ssh",
]);
const SENSITIVE_NAMES = [/^\.env(?:\.|$)/i, /(?:^|[-_.])(?:secret|credential|private[-_]?key)(?:[-_.]|$)/i];
const REDACTABLE_VALUE = /((?:api[_-]?key|token|password|secret)\s*[:=]\s*)([^\s,;]+)/gi;

export function isSecretPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const baseName = parts.at(-1) ?? "";
  return parts.some((part) => SENSITIVE_PATH_SEGMENTS.has(part)) || SENSITIVE_NAMES.some((pattern) => pattern.test(baseName));
}

/** Lightweight glob support for configuration policy (literal, * and **). */
export function matchesGlob(path: string, pattern: string): boolean {
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/", "\u0000GLOBSTAR_SLASH\u0000")
    .replaceAll("**", "\u0000GLOBSTAR\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000GLOBSTAR_SLASH\u0000", "(?:.*/)?")
    .replaceAll("\u0000GLOBSTAR\u0000", ".*");
  return new RegExp(`^${escaped}$`, "i").test(path.replaceAll("\\", "/"));
}

export function isAllowedArtifact(path: string, include: string[] = ["**"], exclude: string[] = []): boolean {
  if (isSecretPath(path)) return false;
  const included = include.some((pattern) => matchesGlob(path, pattern));
  const excluded = exclude.some((pattern) => matchesGlob(path, pattern));
  return included && !excluded;
}

export function safeText(value: string): string {
  return value.replace(REDACTABLE_VALUE, "$1[REDACTED]");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Encrypt source settings before durable storage. A development-only key is never suitable for deployment. */
export class ConfigCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("Observatory configuration key must be exactly 32 bytes.");
  }

  static fromEnvironment(): ConfigCipher {
    const configured = process.env.OBSERVATORY_CONFIG_KEY;
    if (!configured) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("OBSERVATORY_CONFIG_KEY is required in production.");
      }
      return new ConfigCipher(createHash("sha256").update("observatory-development-only-key").digest());
    }
    return new ConfigCipher(Buffer.from(configured, "base64"));
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
  }

  decrypt<T>(value: string): T {
    const raw = Buffer.from(value, "base64");
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(authTag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as T;
  }
}
