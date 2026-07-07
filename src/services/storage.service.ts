/**
 * Storage service — abstracts private object-storage operations.
 * Backed by Supabase Storage REST API. All paths are user-scoped with unique
 * identifiers to prevent collisions (AC-003, AC-006, AC-012).
 */

import { randomUUID } from "crypto";

/**
 * Normalize a Supabase project URL to its origin (scheme + host), dropping any
 * path suffix (e.g. "/rest/v1") or trailing slash. Storage, REST and Auth all
 * live under the same origin at /storage/v1, /rest/v1, /auth/v1 — so a stray
 * path would misroute /storage/v1 requests to PostgREST (PGRST125 errors).
 */
function normalizeOrigin(raw: string): string {
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

const SUPABASE_URL = normalizeOrigin(process.env.SUPABASE_URL ?? "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? "";
const STORAGE_BUCKET = process.env.STORAGE_BUCKET ?? "meal-images";

/** Signed view URL expiration window in seconds (1 hour for display) */
const VIEW_URL_EXPIRES_IN = 3600;

const ALLOWED_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function supabaseStorageHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    apikey: SUPABASE_SERVICE_KEY,
    "Content-Type": "application/json",
  };
}

function isConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
}

export type SignedUploadResult = {
  storageKey: string;
  uploadUrl: string;
  token: string;
};

/**
 * Request a signed upload URL from Supabase Storage.
 * Returns a user-scoped unique storage key plus the pre-signed URL.
 * Throws if SUPABASE_URL or SUPABASE_SERVICE_KEY are not configured.
 */
export async function getSignedUploadUrl(
  userId: string,
  mimeType: string,
): Promise<SignedUploadResult> {
  if (!isConfigured()) {
    throw new Error(
      "Storage service not configured: SUPABASE_URL and SUPABASE_SERVICE_KEY required",
    );
  }

  const ext = ALLOWED_EXTENSIONS[mimeType];
  if (!ext) {
    throw new Error(`Unsupported MIME type: ${mimeType}`);
  }

  const storageKey = `${userId}/${randomUUID()}.${ext}`;
  // Supabase Storage "create signed upload URL": the path segments are
  // upload/sign (NOT sign/upload), and the body is an empty JSON object.
  const url = `${SUPABASE_URL}/storage/v1/object/upload/sign/${STORAGE_BUCKET}/${storageKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: supabaseStorageHeaders(),
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Storage upload URL request failed (${response.status}): ${body}`,
    );
  }

  // Response shape: { url: "/object/upload/sign/{bucket}/{path}?token=<jwt>" }
  const data = (await response.json()) as { url?: string };
  if (!data.url) {
    throw new Error("Storage service returned no upload url");
  }

  const uploadUrl = data.url.startsWith("http")
    ? data.url
    : `${SUPABASE_URL}/storage/v1${data.url}`;
  const token = new URL(uploadUrl).searchParams.get("token") ?? "";

  return { storageKey, uploadUrl, token };
}

/**
 * Request a signed view URL for an existing storage key.
 * Only the image owner should be allowed to call this (ownership enforced at
 * the route layer — AC-006, AC-012).
 */
export async function getSignedViewUrl(storageKey: string): Promise<string> {
  if (!isConfigured()) {
    throw new Error(
      "Storage service not configured: SUPABASE_URL and SUPABASE_SERVICE_KEY required",
    );
  }

  const url = `${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${storageKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: supabaseStorageHeaders(),
    body: JSON.stringify({ expiresIn: VIEW_URL_EXPIRES_IN }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Storage view URL request failed (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as { signedURL?: string };
  if (!data.signedURL) {
    throw new Error("Storage service returned no signedURL for view");
  }

  return data.signedURL.startsWith("http")
    ? data.signedURL
    : `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

/**
 * Delete an image from storage.
 * Called on meal deletion to prevent orphan images (AC-007).
 * Errors are intentionally swallowed after logging — meal deletion must not
 * be blocked by a storage failure (per contract).
 */
export async function deleteImage(storageKey: string): Promise<void> {
  if (!isConfigured()) {
    console.error(
      "[storage] deleteImage skipped: storage not configured",
      storageKey,
    );
    return;
  }

  try {
    const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storageKey}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: supabaseStorageHeaders(),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `[storage] deleteImage failed (${response.status}) for key ${storageKey}: ${body}`,
      );
    }
  } catch (err) {
    // Log deletion failures without blocking caller (AC-007)
    console.error(`[storage] deleteImage threw for key ${storageKey}:`, err);
  }
}

const STORAGE_KEY_MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function mimeTypeFromStorageKey(storageKey: string): string {
  const ext = storageKey.split(".").pop()?.toLowerCase() ?? "";
  return STORAGE_KEY_MIME_MAP[ext] ?? "image/jpeg";
}

/**
 * Download image bytes from private storage and return as base64.
 * Used by the analyze-image route when the client provides a storage_key
 * instead of a base64 payload (BT-001, AC-001).
 */
export async function fetchImageFromStorage(
  storageKey: string,
): Promise<{ base64: string; mimeType: string }> {
  if (!isConfigured()) {
    throw new Error(
      "Storage service not configured: SUPABASE_URL and SUPABASE_SERVICE_KEY required",
    );
  }

  const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storageKey}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Storage fetch failed (${response.status}) for key ${storageKey}: ${body}`,
    );
  }

  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  const mimeType = mimeTypeFromStorageKey(storageKey);

  return { base64, mimeType };
}
