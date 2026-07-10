// Shared error classes for AI vision providers.
// Extracted so multiple provider clients (Gemini, OpenAI, Google) can throw the
// same error types that analyze-image.service classifies for retry/fallback.

export type VisionProvider = "gemini" | "openai" | "google" | "off";

/** 4xx-style failure: the request itself is invalid — never retried, no fallback. */
export class PermanentProviderError extends Error {
  constructor(
    public readonly provider: VisionProvider,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PermanentProviderError";
  }
}

/** Timeout / 5xx / 429 / network failure: may be retried, then fall back. */
export class TransientProviderError extends Error {
  constructor(
    public readonly provider: VisionProvider,
    message: string,
  ) {
    super(message);
    this.name = "TransientProviderError";
  }
}
