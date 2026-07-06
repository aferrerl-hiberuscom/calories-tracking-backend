/**
 * Feature 025 — daily nutrition goals (contract v1.0.0).
 *
 * Defaults are NEVER persisted: GET always answers 200, serving the default
 * targets with is_default=true until the user's first edit (D-BROTE-07).
 */

import { prisma } from "../lib/prisma";

export const DEFAULT_GOALS = {
  calories_kcal_target: 2000,
  protein_g_target: 120,
  carbs_g_target: 220,
  fat_g_target: 65,
} as const;

export type GoalsResponse = {
  calories_kcal_target: number;
  protein_g_target: number;
  carbs_g_target: number;
  fat_g_target: number;
  is_default: boolean;
};

export type GoalsInput = {
  calories_kcal_target: number;
  protein_g_target: number;
  carbs_g_target: number;
  fat_g_target: number;
};

export async function getGoals(userId: string): Promise<GoalsResponse> {
  const goal = await prisma.nutritionGoal.findUnique({ where: { userId } });
  if (!goal) {
    return { ...DEFAULT_GOALS, is_default: true };
  }
  return {
    calories_kcal_target: goal.caloriesKcalTarget,
    protein_g_target: goal.proteinGTarget,
    carbs_g_target: goal.carbsGTarget,
    fat_g_target: goal.fatGTarget,
    is_default: false,
  };
}

export async function upsertGoals(
  userId: string,
  input: GoalsInput,
): Promise<GoalsResponse> {
  const data = {
    caloriesKcalTarget: input.calories_kcal_target,
    proteinGTarget: input.protein_g_target,
    carbsGTarget: input.carbs_g_target,
    fatGTarget: input.fat_g_target,
  };
  const goal = await prisma.nutritionGoal.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  return {
    calories_kcal_target: goal.caloriesKcalTarget,
    protein_g_target: goal.proteinGTarget,
    carbs_g_target: goal.carbsGTarget,
    fat_g_target: goal.fatGTarget,
    is_default: false,
  };
}
