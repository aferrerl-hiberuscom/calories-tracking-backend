/*
  Warnings:

  - A unique constraint covering the columns `[userId,idempotencyKey]` on the table `Meal` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Image" ALTER COLUMN "sizeBytes" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Meal" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Meal_userId_idempotencyKey_key" ON "Meal"("userId", "idempotencyKey");
