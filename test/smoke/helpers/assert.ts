/**
 * assert.ts — Smoke test assertion helpers.
 *
 * Small wrappers for expect().toMatchObject(...) and structural checks
 * that make smoke test failures descriptive without importing a heavy
 * assertion library.
 */

/**
 * Assert that `actual` has at least the shape described by `expected`.
 * Only checks keys present in `expected` — ignores extra keys in `actual`.
 */
export function assertShape(
  actual: unknown,
  expected: Record<string, unknown>,
  label = "value",
): void {
  if (actual === null || actual === undefined) {
    throw new Error(`${label}: expected an object, got ${actual}`);
  }

  if (typeof actual !== "object") {
    throw new Error(`${label}: expected an object, got ${typeof actual}`);
  }

  const obj = actual as Record<string, unknown>;

  for (const [key, expectedVal] of Object.entries(expected)) {
    if (!(key in obj)) {
      throw new Error(`${label}.${key}: missing — expected shape includes this key`);
    }

    const actualVal = obj[key];

    if (expectedVal === null) {
      // null is a special sentinel meaning "any non-null value"
      if (actualVal === null || actualVal === undefined) {
        throw new Error(`${label}.${key}: expected a non-null value, got ${actualVal}`);
      }
      continue;
    }

    if (typeof expectedVal === "object" && expectedVal !== null && !Array.isArray(expectedVal)) {
      assertShape(actualVal, expectedVal as Record<string, unknown>, `${label}.${key}`);
      continue;
    }

    // Direct comparison
    if (JSON.stringify(actualVal) !== JSON.stringify(expectedVal)) {
      throw new Error(
        `${label}.${key}: expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`,
      );
    }
  }
}

/**
 * Assert that `actual` is a non-empty string or, if `expectedSubstring` is
 * provided, that it contains that substring.
 */
export function assertStringContains(
  actual: unknown,
  expectedSubstring: string,
  label = "string",
): void {
  if (typeof actual !== "string") {
    throw new Error(`${label}: expected a string, got ${typeof actual}`);
  }
  if (actual.length === 0) {
    throw new Error(`${label}: expected a non-empty string`);
  }
  if (!actual.includes(expectedSubstring)) {
    throw new Error(
      `${label}: expected to contain "${expectedSubstring}" but got (first 200 chars): ${actual.slice(0, 200)}`,
    );
  }
}

/**
 * Assert that `actual` is an array with at least `minLength` elements.
 * Returns the array for chaining.
 */
export function assertMinLength(
  actual: unknown,
  minLength: number,
  label = "array",
): unknown[] {
  if (!Array.isArray(actual)) {
    throw new Error(`${label}: expected an array, got ${typeof actual}`);
  }
  if (actual.length < minLength) {
    throw new Error(`${label}: expected at least ${minLength} elements, got ${actual.length}`);
  }
  return actual;
}

/**
 * Assert that `actual` is a number greater than `minValue`.
 */
export function assertGreaterThan(
  actual: unknown,
  minValue: number,
  label = "number",
): void {
  if (typeof actual !== "number" || isNaN(actual)) {
    throw new Error(`${label}: expected a number, got ${actual}`);
  }
  if (actual <= minValue) {
    throw new Error(`${label}: expected > ${minValue}, got ${actual}`);
  }
}
