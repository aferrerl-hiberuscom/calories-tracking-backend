import { Router } from "express";
import {
  postLogin,
  postRefresh,
  postRegister,
} from "../controllers/auth.controller";

// Feature 001 — sign-in, sign-up and session-renewal endpoints.
// Mounted at /api/v1/auth with a brute-force rate limit in app.ts.
// Registration added by evolution ui_redesign_brote (contract 001 v2.0.0).
export const authRouter = Router();

authRouter.post("/login", postLogin);
authRouter.post("/register", postRegister);
authRouter.post("/refresh", postRefresh);
