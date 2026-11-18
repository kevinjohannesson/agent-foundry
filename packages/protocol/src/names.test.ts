import { describe, expect, it } from "vitest";
import { deriveMono, nameFromPrompt } from "./names";

describe("nameFromPrompt", () => {
  it("drops filler words and keeps three", () => {
    expect(nameFromPrompt("Please migrate the Button to new tokens")).toBe("Migrate Button new");
  });
  it("falls back for empty prompts", () => {
    expect(nameFromPrompt("   ")).toBe("Untitled");
  });
});

describe("deriveMono", () => {
  it("uses the first letters of two words", () => {
    expect(deriveMono("Button tokens")).toBe("Bt");
  });
  it("uses two letters of a single word", () => {
    expect(deriveMono("Popover")).toBe("Po");
  });
  it("avoids monograms already taken in the workstream", () => {
    expect(deriveMono("Card spacing", ["Cs"])).toBe("Ca");
  });
});
