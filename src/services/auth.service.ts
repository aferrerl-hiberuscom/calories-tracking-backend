/**
 * Feature 001 — authentication service.
 *
 * Issues short-lived access tokens (stateless JWT) and longer-lived opaque
 * refresh tokens (stored as a one-way hash to support rotation + revocation).
 * Failure responses never disclose which credential field was wrong.
 */

import { prisma } from "../lib/prisma";
import { ApiError } from "../middleware/api-error";
import { verifyPassword } from "../lib/password";
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

async function issueTokens(userId: string): Promise<AuthTokens> {
  const accessToken = signAccessToken(userId);
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
  return issueTokens(user.id);
}

export async function refresh(rawRefreshToken: string): Promise<AuthTokens> {
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
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
  return issueTokens(existing.userId);
}
