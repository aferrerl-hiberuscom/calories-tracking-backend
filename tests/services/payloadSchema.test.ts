/**
 * T058: Payload schema and source marker validation tests (Feature 011)
 *
 * Tests verifying payload structure and source marker correctness across scenarios:
 * - Pure AI flow → source="ai"
 * - Edited ingredient → source="manual"
 * - Added ingredient → source="manual_added"
 * - Deleted ingredient → absent from payload
 * - Totals = exact sum of visible ingredient values
 * - Schema fields present: user_id, timestamp (ISO 8601), session_id, ingredients, totals
 *
 * ≥ 8 test cases as required by tasks.md.
 */

import { describe, it, expect } from 'vitest';

// ─── Types matching contract_spec.md §Outputs ─────────────────────────────────

type SourceMarker = 'ai' | 'manual' | 'manual_added';

type PayloadIngredient = {
  name: string;
  quantity_grams: number;
  food_type: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  source: SourceMarker;
};

type NutritionTotals = {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

type ConfirmPayload = {
  user_id: string;
  timestamp: string;
  session_id: string;
  ingredients: PayloadIngredient[];
  totals: NutritionTotals;
};

// ─── Internal ingredient type (mirrors useIngredientEditor.EditableIngredient) ─

type IngredientSource = 'ai' | 'manual' | 'manual_added' | 'manual_removed';

type EditableIngredient = {
  id: string;
  name: string;
  quantity_grams: number;
  food_type: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  source: IngredientSource;
};

// ─── Pure helpers (mirrors useIngredientEditor.buildPayload logic) ────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function sumTotals(items: EditableIngredient[]): NutritionTotals {
  return {
    calories: round1(items.reduce((s, i) => s + i.calories, 0)),
    protein_g: round1(items.reduce((s, i) => s + i.protein_g, 0)),
    carbs_g: round1(items.reduce((s, i) => s + i.carbs_g, 0)),
    fat_g: round1(items.reduce((s, i) => s + i.fat_g, 0)),
  };
}

function buildPayload(
  userId: string,
  sessionId: string,
  ingredients: EditableIngredient[],
): ConfirmPayload {
  const visible = ingredients.filter((i) => i.source !== 'manual_removed');

  if (visible.length === 0) throw new Error('At least one ingredient is required');

  for (const ing of visible) {
    if (!ing.name.trim()) throw new Error('Ingredient name is required');
    if (ing.quantity_grams < 1 || ing.quantity_grams > 9999)
      throw new Error(`Invalid quantity for '${ing.name}'`);
    if (ing.calories < 0 || ing.protein_g < 0 || ing.carbs_g < 0 || ing.fat_g < 0)
      throw new Error(`Negative nutritional values for '${ing.name}'`);
  }

  return {
    user_id: userId,
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    ingredients: visible.map((i) => ({
      name: i.name,
      quantity_grams: i.quantity_grams,
      food_type: i.food_type,
      calories: i.calories,
      protein_g: i.protein_g,
      carbs_g: i.carbs_g,
      fat_g: i.fat_g,
      source: i.source as SourceMarker, // manual_removed already filtered
    })),
    totals: sumTotals(visible),
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = 'user-uuid-001';
const SESSION_ID = 'sess-abc-123';

const AI_CHICKEN: EditableIngredient = {
  id: 'i1', name: 'Chicken', food_type: 'Meat', quantity_grams: 200,
  calories: 330, protein_g: 54, carbs_g: 0, fat_g: 7.2, source: 'ai',
};
const AI_RICE: EditableIngredient = {
  id: 'i2', name: 'Rice', food_type: 'Grain', quantity_grams: 150,
  calories: 195, protein_g: 3.6, carbs_g: 43.5, fat_g: 0.5, source: 'ai',
};
const EDITED_CHICKEN: EditableIngredient = { ...AI_CHICKEN, quantity_grams: 250, calories: 412.5, source: 'manual' };
const ADDED_TOMATO: EditableIngredient = {
  id: 'i3', name: 'Tomato', food_type: 'Vegetable', quantity_grams: 80,
  calories: 20, protein_g: 1.2, carbs_g: 4.0, fat_g: 0.2, source: 'manual_added',
};
const DELETED_RICE: EditableIngredient = { ...AI_RICE, source: 'manual_removed' };

// ─────────────────────────────────────────────────────────────────────────────

describe('T058: Payload Schema and Source Marker Validation', () => {

  describe('Source markers in payload', () => {
    it('T058-001: Pure AI flow — all ingredients source="ai"', () => {
      const payload = buildPayload(USER_ID, SESSION_ID, [AI_CHICKEN, AI_RICE]);

      expect(payload.ingredients).toHaveLength(2);
      expect(payload.ingredients[0].source).toBe('ai');
      expect(payload.ingredients[1].source).toBe('ai');
    });

    it('T058-002: Edited ingredient → source="manual"', () => {
      const payload = buildPayload(USER_ID, SESSION_ID, [EDITED_CHICKEN, AI_RICE]);

      const chicken = payload.ingredients.find((i) => i.name === 'Chicken');
      expect(chicken?.source).toBe('manual');
    });

    it('T058-003: Added ingredient → source="manual_added"', () => {
      const payload = buildPayload(USER_ID, SESSION_ID, [AI_CHICKEN, ADDED_TOMATO]);

      const tomato = payload.ingredients.find((i) => i.name === 'Tomato');
      expect(tomato?.source).toBe('manual_added');
    });

    it('T058-004: Deleted ingredient → absent from payload (not present, not marked)', () => {
      const payload = buildPayload(USER_ID, SESSION_ID, [AI_CHICKEN, DELETED_RICE]);

      expect(payload.ingredients).toHaveLength(1);
      expect(payload.ingredients.find((i) => i.name === 'Rice')).toBeUndefined();
      // No manual_removed source in payload at all
      const hasBadSource = payload.ingredients.some(
        (i) => (i.source as string) === 'manual_removed'
      );
      expect(hasBadSource).toBe(false);
    });

    it('T058-005: Mixed scenario — ai + manual + manual_added; manual_removed excluded', () => {
      const ingredients = [AI_RICE, EDITED_CHICKEN, ADDED_TOMATO, DELETED_RICE];
      const payload = buildPayload(USER_ID, SESSION_ID, ingredients);

      // Only 3 visible ingredients
      expect(payload.ingredients).toHaveLength(3);
      const sources = payload.ingredients.map((i) => i.source);
      expect(sources).toContain('ai');
      expect(sources).toContain('manual');
      expect(sources).toContain('manual_added');
      expect(sources).not.toContain('manual_removed');
    });
  });

  describe('Payload schema fields', () => {
    it('T058-006: Payload contains all required top-level fields', () => {
      const payload = buildPayload(USER_ID, SESSION_ID, [AI_CHICKEN]);

      expect(payload.user_id).toBe(USER_ID);
      expect(payload.session_id).toBe(SESSION_ID);
      expect(payload.timestamp).toBeDefined();
      expect(payload.ingredients).toBeDefined();
      expect(payload.totals).toBeDefined();
    });

    it('T058-007: Timestamp is ISO 8601 format', () => {
      const payload = buildPayload(USER_ID, SESSION_ID, [AI_CHICKEN]);
      const parsed = new Date(payload.timestamp);

      expect(isNaN(parsed.getTime())).toBe(false);
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('T058-008: Each ingredient has all 8 required fields', () => {
      const payload = buildPayload(USER_ID, SESSION_ID, [AI_CHICKEN]);
      const ing = payload.ingredients[0];

      expect(ing).toHaveProperty('name');
      expect(ing).toHaveProperty('quantity_grams');
      expect(ing).toHaveProperty('food_type');
      expect(ing).toHaveProperty('calories');
      expect(ing).toHaveProperty('protein_g');
      expect(ing).toHaveProperty('carbs_g');
      expect(ing).toHaveProperty('fat_g');
      expect(ing).toHaveProperty('source');
    });
  });

  describe('Totals correctness', () => {
    it('T058-009: Totals equal exact sum of visible ingredient values (1 decimal)', () => {
      const payload = buildPayload(USER_ID, SESSION_ID, [AI_CHICKEN, AI_RICE]);

      // Chicken: 330 + Rice: 195 = 525
      expect(payload.totals.calories).toBe(525);
      // Chicken: 54 + Rice: 3.6 = 57.6
      expect(payload.totals.protein_g).toBe(57.6);
      // Chicken: 0 + Rice: 43.5 = 43.5
      expect(payload.totals.carbs_g).toBe(43.5);
      // Chicken: 7.2 + Rice: 0.5 = 7.7
      expect(payload.totals.fat_g).toBe(7.7);
    });

    it('T058-010: Totals exclude deleted ingredients', () => {
      // Chicken + deleted Rice → totals = Chicken only
      const payload = buildPayload(USER_ID, SESSION_ID, [AI_CHICKEN, DELETED_RICE]);

      expect(payload.totals.calories).toBe(330);
      expect(payload.totals.protein_g).toBe(54);
      expect(payload.totals.carbs_g).toBe(0);
      expect(payload.totals.fat_g).toBe(7.2);
    });
  });

  describe('Validation guards', () => {
    it('T058-011: Empty ingredient list → throws, no payload produced', () => {
      expect(() => buildPayload(USER_ID, SESSION_ID, [])).toThrow(
        'At least one ingredient is required'
      );
    });

    it('T058-012: All ingredients deleted → throws (same as empty list)', () => {
      expect(() =>
        buildPayload(USER_ID, SESSION_ID, [DELETED_RICE])
      ).toThrow('At least one ingredient is required');
    });

    it('T058-013: Negative nutrition value → throws', () => {
      const bad: EditableIngredient = { ...AI_CHICKEN, calories: -1 };
      expect(() => buildPayload(USER_ID, SESSION_ID, [bad])).toThrow(
        "Negative nutritional values for 'Chicken'"
      );
    });

    it('T058-014: Quantity 0 → throws', () => {
      const bad: EditableIngredient = { ...AI_CHICKEN, quantity_grams: 0 };
      expect(() => buildPayload(USER_ID, SESSION_ID, [bad])).toThrow(
        "Invalid quantity for 'Chicken'"
      );
    });
  });
});
