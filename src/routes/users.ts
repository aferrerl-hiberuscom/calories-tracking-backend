import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getMe, postMe } from "../controllers/users.controller";

// Feature 022 — self-provisioning and profile. Both routes are self-scoped
// (identity from the token only); there is no cross-user access vector here.
export const usersRouter = Router();

usersRouter.post("/me", requireAuth, postMe);
usersRouter.get("/me", requireAuth, getMe);
