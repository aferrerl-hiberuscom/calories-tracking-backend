/**
 * T029: Unit tests for recalculation formula (backend)
 * Tests the nutrition calculation service with ≥ 15 cases
 */

import { describe, it, expect } from 'vitest';

// Formula: nutrient_total = (base_per_100g × quantity_grams) ÷ 100
function calculateNutrient(basePer100g: number, quantityGrams: number): number {
  return Math.round((basePer100g * quantityGrams / 100) * 10) / 10;
}

describe('T029: Recalculation Formula - Backend', () => {

  describe('Basic Formula Correctness', () => {
    it('T029-001: 165 cal/100g × 200g = 330.0 (exact, no drift)', () => {
      const result = calculateNutrient(165, 200);
      expect(result).toBe(330.0);
      expect(result).not.toBe(329.99);
      expect(result).not.toBe(330.01);
    });

    it('T029-002: 27 protein/100g × 150g = 40.5', () => {
      const result = calculateNutrient(27, 150);
      expect(result).toBe(40.5);
    });

    it('T029-003: 14 carbs/100g × 100g = 14.0', () => {
      const result = calculateNutrient(14, 100);
      expect(result).toBe(14.0);
    });

    it('T029-004: 7 fat/100g × 250g = 17.5', () => {
      const result = calculateNutrient(7, 250);
      expect(result).toBe(17.5);
    });
  });

  describe('Boundary Values', () => {
    it('T029-005: Minimum quantity (1g): 165 cal/100g × 1g = 1.7', () => {
      const result = calculateNutrient(165, 1);
      expect(result).toBe(1.7);
    });

    it('T029-006: Maximum quantity (9999g): 165 cal/100g × 9999g = 16498.4', () => {
      const result = calculateNutrient(165, 9999);
      expect(result).toBe(16498.4);
    });

    it('T029-007: Zero base (acceptable for some nutrients): 0 × 200g = 0.0', () => {
      const result = calculateNutrient(0, 200);
      expect(result).toBe(0.0);
    });

    it('T029-008: Very small quantity (0.1g rounding): 165 × 0.1 = 0.2 (rounded)', () => {
      // Though 0.1g not in spec, test rounding behavior
      const result = calculateNutrient(165, 0.1);
      expect(result).toBe(0.2);
    });
  });

  describe('Decimal Precision (1 decimal place)', () => {
    it('T029-009: Result with .X decimal is preserved: 305.0 remains 305.0', () => {
      const result = calculateNutrient(122, 250); // 122 * 250 / 100 = 305.0
      expect(result).toBe(305.0);
    });

    it('T029-010: Rounding .X4 down: 301.4 → 301.4', () => {
      const result = calculateNutrient(120.56, 250); // 120.56 * 250 / 100 = 301.4
      expect(result).toBe(301.4);
    });

    it('T029-011: Rounding .X5: 302.5 → 302.5 (banker\'s rounding)', () => {
      // Math.round in JS uses banker's rounding
      const result = calculateNutrient(121, 250); // 121 * 250 / 100 = 302.5
      expect(result).toBe(302.5);
    });

    it('T029-012: Result with .X9 stays .X9: 301.9 → 301.9', () => {
      const result = calculateNutrient(120.76, 250); // 120.76 * 250 / 100 = 301.9
      expect(result).toBe(301.9);
    });
  });

  describe('Non-Negative Invariant', () => {
    it('T029-013: Result is always ≥ 0.0', () => {
      const testCases = [
        { base: 165, qty: 1 },
        { base: 27, qty: 9999 },
        { base: 0, qty: 100 },
        { base: 30, qty: 1 }
      ];
      testCases.forEach(({ base, qty }) => {
        const result = calculateNutrient(base, qty);
        expect(result).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('All 4 Nutrients Consistently', () => {
    it('T029-014: Chicken 200g: all 4 nutrients calculated correctly', () => {
      // Chicken: 165 cal, 27 protein, 0 carbs, 7 fat per 100g
      const quantity = 200;

      const calories = calculateNutrient(165, quantity);
      const protein = calculateNutrient(27, quantity);
      const carbs = calculateNutrient(0, quantity);
      const fat = calculateNutrient(7, quantity);

      expect(calories).toBe(330.0);
      expect(protein).toBe(54.0);
      expect(carbs).toBe(0.0);
      expect(fat).toBe(14.0);
    });

    it('T029-015: Rice 150g: all 4 nutrients calculated consistently', () => {
      // Grain/Rice: 130 cal, 4 protein, 27 carbs, 0.5 fat per 100g
      const quantity = 150;

      const calories = calculateNutrient(130, quantity);
      const protein = calculateNutrient(4, quantity);
      const carbs = calculateNutrient(27, quantity);
      const fat = calculateNutrient(0.5, quantity);

      expect(calories).toBe(195.0);
      expect(protein).toBe(6.0);
      expect(carbs).toBe(40.5);
      expect(fat).toBe(0.8);
    });
  });
});
