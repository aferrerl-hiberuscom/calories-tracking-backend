import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  getMe,
  getMyGoals,
  postMe,
  putMe,
  putMyGoals,
} from "../controllers/users.controller";

// Feature 022 — self-provisioning and profile. All routes are self-scoped
// (identity from the token only); there is no cross-user access vector here.
// Evolution ui_redesign_brote: PUT /me (name, 022 v1.3) and nutrition goals
// (feature 025, GET always 200 with defaults + is_default).
export const usersRouter = Router();

usersRouter.post("/me", requireAuth, postMe);
usersRouter.get("/me", requireAuth, getMe);
usersRouter.put("/me", requireAuth, putMe);
usersRouter.get("/me/goals", requireAuth, getMyGoals);
usersRouter.put("/me/goals", requireAuth, putMyGoals);
