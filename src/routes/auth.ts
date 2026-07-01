import { Router } from "express";
import { postLogin, postRefresh } from "../controllers/auth.controller";

// Feature 001 — sign-in and session-renewal endpoints.
// Mounted at /api/v1/auth with a brute-force rate limit in app.ts.
export const authRouter = Router();

authRouter.post("/login", postLogin);
authRouter.post("/refresh", postRefresh);
