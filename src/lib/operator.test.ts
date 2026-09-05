import { afterEach, describe, expect, it } from "vitest";
import { isOperator, operatorIds } from "./operator";

/**
 * PLAN.md §9.4 asks for "an operator role (env-allowlisted user ids at
 * first)". The thing worth pinning is what happens when it is unset — a
 * misconfigured deploy must grant nobody, not everybody.
 */
afterEach(() => {
  delete process.env.WHAIKEY_OPERATOR_IDS;
});

const asUser = (id: string) => ({ id });

describe("isOperator", () => {
  it("admits an id on the list", () => {
    process.env.WHAIKEY_OPERATOR_IDS = "user-1, user-2";
    expect(isOperator(asUser("user-1"))).toBe(true);
    expect(isOperator(asUser("user-2"))).toBe(true);
    expect(isOperator(asUser("user-3"))).toBe(false);
  });

  it("grants nobody when the variable is missing or empty", () => {
    expect(isOperator(asUser("user-1"))).toBe(false);
    process.env.WHAIKEY_OPERATOR_IDS = "";
    expect(isOperator(asUser("user-1"))).toBe(false);
    process.env.WHAIKEY_OPERATOR_IDS = " , ,";
    expect(isOperator(asUser("user-1"))).toBe(false);
    expect(operatorIds().size).toBe(0);
  });

  it("is not fooled by a signed-out viewer", () => {
    process.env.WHAIKEY_OPERATOR_IDS = "user-1";
    expect(isOperator(null)).toBe(false);
    expect(isOperator(undefined)).toBe(false);
  });
});
