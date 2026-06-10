-- AlterTable
ALTER TABLE "meal_ingredients" ADD COLUMN     "aiCaloriesKcal" DOUBLE PRECISION,
ADD COLUMN     "allergen" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allergenList" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "dbCaloriesKcal" DOUBLE PRECISION,
ADD COLUMN     "dietaryType" VARCHAR(20),
ADD COLUMN     "discrepancyDetected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nutritionSuspicious" BOOLEAN NOT NULL DEFAULT false;
