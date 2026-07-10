-- CreateEnum
CREATE TYPE "ProductSource" AS ENUM ('OFF', 'USER_LABEL', 'MANUAL');

-- AlterEnum
ALTER TYPE "IngredientSource" ADD VALUE 'PRODUCT';

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "brand" VARCHAR(120),
    "caloriesKcal100g" DOUBLE PRECISION NOT NULL,
    "proteinG100g" DOUBLE PRECISION NOT NULL,
    "carbsG100g" DOUBLE PRECISION NOT NULL,
    "fatG100g" DOUBLE PRECISION NOT NULL,
    "servingSizeG" DOUBLE PRECISION,
    "servingLabel" VARCHAR(60),
    "source" "ProductSource" NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_barcode_key" ON "products"("barcode");
