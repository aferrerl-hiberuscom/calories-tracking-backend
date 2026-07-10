// Feature 026 — barcode normalization (contract §2, decision D-BAR-10).
// Canonical Product key: digits only; UPC-A (12) is left-padded to EAN-13;
// EAN-8 kept as-is. Anything else is invalid.

export function normalizeBarcode(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(trimmed)) {
    return null;
  }
  return trimmed.length === 12 ? `0${trimmed}` : trimmed;
}
