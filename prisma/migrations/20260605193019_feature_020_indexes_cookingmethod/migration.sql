-- AlterTable
ALTER TABLE "Ingredient" ADD COLUMN     "cookingMethod" TEXT;

-- CreateIndex
CREATE INDEX "Meal_userId_mealDate_idx" ON "Meal"("userId", "mealDate");

-- CreateIndex
CREATE INDEX "Meal_userId_idx" ON "Meal"("userId");
