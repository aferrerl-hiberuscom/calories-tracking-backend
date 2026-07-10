// Global test hygiene.
//
// @prisma/client auto-loads the backend .env at import time, which leaks the
// developer's real config (GEMINI_API_KEY, MACROS_FROM_DB, …) into the vitest
// process. The Gemini provider and the hybrid DB-macros step are gated on
// those vars, so a leaked key silently reroutes every analyze-image test
// through Gemini and eats the mocked fetch queues (timeouts, wrong provider).
//
// Neutralize ONLY the vars that gate the new behavior — everything else keeps
// its historical semantics. Tests that want Gemini behavior can set
// GEMINI_API_KEY explicitly inside their own beforeEach/it (runs after this).

import { beforeEach } from "vitest";

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_BASE_URL;
  delete process.env.MACROS_FROM_DB;
});
