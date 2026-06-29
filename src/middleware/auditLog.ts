/**
 * Feature 013 — Audit logging middleware.
 *
 * Logs per-request audit entries with:
 *   user_id, endpoint, method, timestamp, status, latency_ms, error_message?
 *
 * Security constraints (hard rules):
 *   - NEVER log req.body (payload content)
 *   - NEVER log Authorization header or token content
 *   - NEVER log image data or LLM responses
 *   - error_message contains only the error code string, not a stack trace
 */

import type { NextFunction, Request, Response } from "express";

export interface AuditLogEntry {
  timestamp: string;
  user_id: string | null;
  endpoint: string;
  method: string;
  status: number;
  latency_ms: number;
  error_message: string | null;
}

export function auditLog(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on("finish", () => {
    const latencyMs = Date.now() - start;

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      user_id: req.userId ?? null,
      endpoint: req.originalUrl,
      method: req.method,
      status: res.statusCode,
      latency_ms: latencyMs,
      error_message: res.statusCode >= 400 ? res.locals.errorCode ?? "request_failed" : null,
    };

    // Structured JSON — intentionally no body, headers, or token fields.
    console.log(JSON.stringify(entry));
  });

  next();
}
