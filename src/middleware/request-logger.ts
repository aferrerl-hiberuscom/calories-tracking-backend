import type { NextFunction, Request, Response } from "express";

// Security constraints (hard rules), carried over from the removed auditLog.ts:
//   - NEVER log req.body (payload content)
//   - NEVER log Authorization header or token content
//   - NEVER log image data or LLM responses
//   - error_message contains only the error code string, not a stack trace

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on("finish", () => {
    const latencyMs = Date.now() - start;
    const payload = {
      timestamp: new Date().toISOString(),
      user_id: req.userId ?? null,
      endpoint: req.originalUrl,
      method: req.method,
      status: res.statusCode,
      latency_ms: latencyMs,
      error_message:
        res.statusCode >= 400 ? res.locals.errorCode ?? "request_failed" : null,
    };

    // Structured JSON logs without payload content or secrets.
    console.log(JSON.stringify(payload));
  });

  next();
}
