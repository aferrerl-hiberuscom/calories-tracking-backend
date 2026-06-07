import { prisma } from "./prisma";
import { ApiError } from "../middleware/api-error";

/**
 * Extracts the Supabase Storage key from a full storage URL.
 *
 * Supabase public URLs follow the pattern:
 *   https://<project>.supabase.co/storage/v1/object/public/<bucket>/<key>
 * or signed/authenticated URLs:
 *   https://<project>.supabase.co/storage/v1/object/sign/<bucket>/<key>?token=...
 *
 * We extract everything after the bucket segment as the storage_key.
 */
export function extractStorageKey(imageUrl: string): string {
  try {
    const url = new URL(imageUrl);
    // Match both public and authenticated URL patterns
    const match = url.pathname.match(
      /\/storage\/v1\/object\/(?:public|sign)\/[^/]+\/(.+)/,
    );
    if (!match?.[1]) {
      throw new Error("path does not match Supabase storage pattern");
    }
    // Strip any query string that might have leaked into the path
    return match[1].split("?")[0];
  } catch {
    throw new ApiError(
      400,
      "INVALID_IMAGE_URL",
      "image_url is not a valid Supabase storage URL",
    );
  }
}

/**
 * Verifies that the image identified by storageKey belongs to userId.
 * Resolves ownership via: Image.storageKey → Image.meal → Meal.userId.
 *
 * @throws ApiError 404 if the image is not found in the database.
 * @throws ApiError 403 if the image belongs to a different user.
 */
export async function verifyImageOwnership(
  storageKey: string,
  userId: string,
): Promise<void> {
  const image = await prisma.image.findFirst({
    where: { storageKey },
    include: { meal: { select: { userId: true } } },
  });

  if (!image) {
    throw new ApiError(404, "IMAGE_NOT_FOUND", "Image not found");
  }

  if (image.meal.userId !== userId) {
    throw new ApiError(
      403,
      "FORBIDDEN_OWNERSHIP",
      "You do not have access to this image",
    );
  }
}
