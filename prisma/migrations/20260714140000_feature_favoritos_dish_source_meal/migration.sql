-- Evolution favoritos_mis_platos — link a favorite Dish to its source Meal.

-- AlterTable
ALTER TABLE "dishes" ADD COLUMN "sourceMealId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "dishes_sourceMealId_key" ON "dishes"("sourceMealId");

-- AddForeignKey
ALTER TABLE "dishes" ADD CONSTRAINT "dishes_sourceMealId_fkey" FOREIGN KEY ("sourceMealId") REFERENCES "Meal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
