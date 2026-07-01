import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { ApiError } from "../middleware/api-error";

// Access tokens are short-lived (contract: "treat access tokens as short-lived").
const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60; // 15 minutes
// Refresh tokens are longer-lived and rotated on each renewal.
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function getAccessTtlSeconds(): number {
  const raw = Number(process.env.ACCESS_TOKEN_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ACCESS_TTL_SECONDS;
}

export function getRefreshTtlSeconds(): number {
  const raw = Number(process.env.REFRESH_TOKEN_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REFRESH_TTL_SECONDS;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new ApiError(500, "CONFIG_ERROR", "JWT secret is not configured");
  }
  return secret;
}

/**
 * Stateless access token. `sub` carries the user id, matching the existing
 * `requireAuth` middleware that reads `decoded.sub`.
 */
export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, getJwtSecret(), {
    expiresIn: getAccessTtlSeconds(),
  });
}

export type GeneratedRefreshToken = {
  /** Opaque secret returned to the client (never stored server-side). */
  token: string;
  /** One-way hash persisted server-side for lookup/rotation/revocation. */
  tokenHash: string;
  expiresAt: Date;
};

/** Hash a raw refresh token for storage/lookup (deterministic, non-reversible). */
export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateRefreshToken(): GeneratedRefreshToken {
  const token = crypto.randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + getRefreshTtlSeconds() * 1000),
  };
}
