/**
 * Feature 022 — user provisioning and profile.
 */

import { prisma } from "../lib/prisma";
import { ApiError } from "../middleware/api-error";

export type UserProfile = {
  id: string;
  email: string;
  // Evolution ui_redesign_brote (022 v1.3): editable display name.
  name: string | null;
  createdAt: Date;
};

export type EnsureUserResult = {
  user: UserProfile;
  created: boolean;
};

// Never selects passwordHash (BR-030): credential material must never leak.
const PROFILE_SELECT = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
} as const;

/**
 * Idempotent provisioning (BR-029): returns the existing record if the
 * authenticated identity already has one, otherwise creates it. A colliding
 * email on a different id is rejected as a conflict (BR-028) instead of
 * silently overwriting another user's record.
 */
export async function ensureCurrentUser(
  id: string,
  email: string,
): Promise<EnsureUserResult> {
  const existing = await prisma.user.findUnique({
    where: { id },
    select: PROFILE_SELECT,
  });
  if (existing) {
    return { user: existing, created: false };
  }

  try {
    const user = await prisma.user.create({
      data: { id, email },
      select: PROFILE_SELECT,
    });
    return { user, created: true };
  } catch (error) {
    // Prisma unique-constraint violation (email) — reject as a conflict
    // (BR-028) rather than wrapping as a generic 500.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      throw new ApiError(409, "CONFLICT", "Email already in use");
    }
    throw error;
  }
}

/** Throws 404 if the authenticated identity has not been provisioned yet. */
export async function getCurrentUser(id: string): Promise<UserProfile> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: PROFILE_SELECT,
  });
  if (!user) {
    throw new ApiError(404, "NOT_FOUND", "User not provisioned");
  }
  return user;
}

/**
 * Evolution ui_redesign_brote (022 v1.3, 025 v1.0.0): update the display
 * name shown in the «Hola, {nombre}» header and Perfil (D1).
 */
export async function updateCurrentUser(
  id: string,
  data: { name: string },
): Promise<UserProfile> {
  const existing = await prisma.user.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    throw new ApiError(404, "NOT_FOUND", "User not provisioned");
  }
  return prisma.user.update({
    where: { id },
    data: { name: data.name },
    select: PROFILE_SELECT,
  });
}
