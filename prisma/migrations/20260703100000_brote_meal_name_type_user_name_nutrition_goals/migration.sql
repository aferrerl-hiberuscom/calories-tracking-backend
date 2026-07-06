-- Evolution ui_redesign_brote — shared migration (contracts 013 v2.1.0,
-- 014 v2.0.0 A-014-04, 022 v1.3 Amendment 3, 025 v1.0.0).
--
-- 1. Meal.name + Meal.mealType with backfill:
--    name        -> 'Comida' for existing rows
--    mealType    -> by hour bands of mealDate (BREAKFAST 05-11, LUNCH 12-16,
--                   DINNER 17-23, SNACK 00-04)
-- 2. User.name (nullable display name)
-- 3. nutrition_goals table (Feature 025)

-- CreateEnum
CREATE TYPE "MealType" AS ENUM ('BREAKFAST', 'LUNCH', 'DINNER', 'SNACK');

-- Meal: add nullable, backfill, then enforce NOT NULL
ALTER TABLE "Meal" ADD COLUMN "name" VARCHAR(120);
ALTER TABLE "Meal" ADD COLUMN "mealType" "MealType";

UPDATE "Meal" SET "name" = 'Comida' WHERE "name" IS NULL;
UPDATE "Meal"
SET "mealType" = CASE
  WHEN EXTRACT(HOUR FROM "mealDate") BETWEEN 5 AND 11 THEN 'BREAKFAST'::"MealType"
  WHEN EXTRACT(HOUR FROM "mealDate") BETWEEN 12 AND 16 THEN 'LUNCH'::"MealType"
  WHEN EXTRACT(HOUR FROM "mealDate") BETWEEN 17 AND 23 THEN 'DINNER'::"MealType"
  ELSE 'SNACK'::"MealType"
END
WHERE "mealType" IS NULL;

ALTER TABLE "Meal" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "Meal" ALTER COLUMN "mealType" SET NOT NULL;

-- User: display name (022 v1.3 Amendment 3)
ALTER TABLE "User" ADD COLUMN "name" VARCHAR(120);

-- CreateTable (Feature 025)
CREATE TABLE "nutrition_goals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caloriesKcalTarget" INTEGER NOT NULL,
    "proteinGTarget" INTEGER NOT NULL,
    "carbsGTarget" INTEGER NOT NULL,
    "fatGTarget" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nutrition_goals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nutrition_goals_userId_key" ON "nutrition_goals"("userId");

-- AddForeignKey
ALTER TABLE "nutrition_goals" ADD CONSTRAINT "nutrition_goals_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
