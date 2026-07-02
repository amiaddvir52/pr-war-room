import { describe, it, expect } from "vitest";
import { extractJsonObjects } from "../../src/util/extractJsonObjects.js";

describe("extractJsonObjects", () => {
  it("extracts a bare object", () => {
    expect(extractJsonObjects('{"a":1}')).toEqual(['{"a":1}']);
  });

  it("extracts multiple top-level objects in source order", () => {
    expect(extractJsonObjects('first {"a":1} then {"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("does not split on braces inside string values", () => {
    const text = '{"note":"use {x} and {y}"}';
    expect(extractJsonObjects(text)).toEqual([text]);
  });

  it("honours escaped quotes inside strings", () => {
    const text = '{"note":"a \\" then } still inside"}';
    expect(extractJsonObjects(text)).toEqual([text]);
  });

  it("captures a nested object as one top-level object", () => {
    const text = '{"outer":{"inner":1}}';
    expect(extractJsonObjects(text)).toEqual([text]);
  });

  it("still finds a valid object after an unbalanced quote in surrounding prose", () => {
    // The lone opening quote must NOT swallow the trailing object (the bug fix).
    const text = 'He said "hi. Verdict: {"is_supported": true}';
    expect(extractJsonObjects(text)).toEqual(['{"is_supported": true}']);
  });

  it("returns balanced-but-not-JSON substrings (the caller validates)", () => {
    expect(extractJsonObjects("noise {x} more")).toEqual(["{x}"]);
  });

  it("returns nothing when there is no object", () => {
    expect(extractJsonObjects("no braces here")).toEqual([]);
  });

  it("ignores an object that never closes", () => {
    expect(extractJsonObjects('prefix {"a":1 unterminated')).toEqual([]);
  });
});
