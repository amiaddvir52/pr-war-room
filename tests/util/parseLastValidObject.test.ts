import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseLastValidObject } from "../../src/util/parseLastValidObject.js";

const Schema = z.object({ answer: z.string(), score: z.number().min(0).max(1) });
const VALID = { answer: "yes", score: 0.5 };

describe("parseLastValidObject", () => {
  it("reads a bare JSON object (the structured-output / API path)", () => {
    expect(parseLastValidObject(JSON.stringify(VALID), Schema)).toEqual(VALID);
  });

  it("reads a fenced object wrapped in prose (the CLI path)", () => {
    const text = `Here it is:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\ndone.`;
    expect(parseLastValidObject(text, Schema)).toEqual(VALID);
  });

  it("keeps the LAST valid object when an example precedes the real answer", () => {
    const example = { answer: "example", score: 0 };
    const text = `Example: ${JSON.stringify(example)}\nActual: ${JSON.stringify(VALID)}`;
    expect(parseLastValidObject(text, Schema)?.answer).toBe("yes");
  });

  it("skips trailing invalid objects and keeps the last VALID one", () => {
    const text = `${JSON.stringify(VALID)}\n{"answer": "bad", "score": 2}`;
    expect(parseLastValidObject(text, Schema)).toEqual(VALID);
  });

  it("returns null on missing / malformed / schema-invalid output", () => {
    expect(parseLastValidObject("no json here", Schema)).toBeNull();
    expect(parseLastValidObject("", Schema)).toBeNull();
    expect(parseLastValidObject("{x}", Schema)).toBeNull(); // balanced but not JSON
    expect(parseLastValidObject('{"answer": "y"}', Schema)).toBeNull(); // missing field
    expect(parseLastValidObject('{"answer": "y", "score": 2}', Schema)).toBeNull(); // range
  });

  it("tolerates extra keys alongside the expected shape", () => {
    const text = JSON.stringify({ ...VALID, notes: "extra" });
    expect(parseLastValidObject(text, Schema)).toEqual(VALID);
  });

  it("handles braces and escaped quotes inside string values", () => {
    const tricky = { answer: 'the guard `if (x) { "drop" }` is missing', score: 1 };
    expect(parseLastValidObject(JSON.stringify(tricky), Schema)).toEqual(tricky);
  });

  it("is not derailed by a lone unbalanced quote in surrounding prose", () => {
    const text = `A stray " quote…\n${JSON.stringify(VALID)}`;
    expect(parseLastValidObject(text, Schema)).toEqual(VALID);
  });
});
