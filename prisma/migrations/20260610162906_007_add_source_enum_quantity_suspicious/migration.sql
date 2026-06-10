/*
  Warnings:

  - You are about to drop the `Ingredient` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "IngredientSource" AS ENUM ('VISIBLE', 'INFERRED', 'MANUAL', 'ESTIMATED_GENERIC', 'CONSOLIDATED', 'MISSING');

-- DropForeignKey
ALTER TABLE "Ingredient" DROP CONSTRAINT "Ingredient_mealId_fkey";

-- DropTable
DROP TABLE "Ingredient";

-- CreateTable
CREATE TABLE "meal_ingredients" (
    "id" TEXT NOT NULL,
    "mealId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "quantityG" DOUBLE PRECISION NOT NULL,
    "source" "IngredientSource" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "quantitySuspicious" BOOLEAN NOT NULL DEFAULT false,
    "cookingMethod" VARCHAR(20),
    "caloriesKcal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "carbsG" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "proteinG" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fatG" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "meal_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nutritional_reference" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "caloriesPer100g" DOUBLE PRECISION NOT NULL,
    "proteinPer100g" DOUBLE PRECISION NOT NULL,
    "carbsPer100g" DOUBLE PRECISION NOT NULL,
    "fatPer100g" DOUBLE PRECISION NOT NULL,
    "aliases" TEXT[],

    CONSTRAINT "nutritional_reference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meal_ingredients_mealId_idx" ON "meal_ingredients"("mealId");

-- CreateIndex
CREATE INDEX "meal_ingredients_source_idx" ON "meal_ingredients"("source");

-- CreateIndex
CREATE INDEX "meal_ingredients_confidence_idx" ON "meal_ingredients"("confidence");

-- CreateIndex
CREATE INDEX "nutritional_reference_name_idx" ON "nutritional_reference"("name");

-- AddForeignKey
ALTER TABLE "meal_ingredients" ADD CONSTRAINT "meal_ingredients_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "Meal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
