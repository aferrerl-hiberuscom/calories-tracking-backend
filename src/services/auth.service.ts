/**
 * Feature 001 — authentication service.
 *
 * Issues short-lived access tokens (stateless JWT) and longer-lived opaque
 * refresh tokens (stored as a one-way hash to support rotation + revocation).
 * Failure responses never disclose which credential field was wrong.
 */

import { prisma } from "../lib/prisma";
import { ApiError } from "../middleware/api-error";
import { hashPassword, verifyPassword } from "../lib/password";
import {
  generateRefreshToken,
  getAccessTtlSeconds,
  hashRefreshToken,
  signAccessToken,
} from "../lib/auth-tokens";

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

// Generic, non-disclosing error (contract Invariant 5).
function invalidCredentials(): ApiError {
  return new ApiError(401, "UNAUTHORIZED", "Invalid email or password");
}

async function issueTokens(userId: string, email: string): Promise<AuthTokens> {
  const accessToken = signAccessToken(userId, email);
  const refresh = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
    },
  });
  return {
    accessToken,
    refreshToken: refresh.token,
    expiresIn: getAccessTtlSeconds(),
  };
}

/**
 * Evolution ui_redesign_brote — contract 001 v2.0.0 (registration in scope,
 * D-BROTE-04). Creates the account (provisioning per 022 v1.3) and issues
 * tokens immediately (auto-login). Duplicate email -> 409 CONFLICT.
 */
export async function register(
  email: string,
  password: string,
  name?: string,
): Promise<AuthTokens> {
  const passwordHash = await hashPassword(password);
  try {
    const user = await prisma.user.create({
      data: { email, passwordHash, name: name ?? null },
      select: { id: true, email: true },
    });
    return issueTokens(user.id, user.email);
  } catch (error) {
    // Prisma unique-constraint violation on email (BR-028 pattern from 022).
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      throw new ApiError(409, "CONFLICT", "Email already registered");
    }
    throw error;
  }
}

export async function login(
  email: string,
  password: string,
): Promise<AuthTokens> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    throw invalidCredentials();
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw invalidCredentials();
  }
  return issueTokens(user.id, user.email);
}

export async function refresh(rawRefreshToken: string): Promise<AuthTokens> {
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (
    !existing ||
    existing.revokedAt !== null ||
    existing.expiresAt.getTime() <= Date.now()
  ) {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid or expired refresh token");
  }
  // Rotate: revoke the consumed token before issuing a fresh pair.
  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });
  return issueTokens(existing.userId, existing.user.email);
}
