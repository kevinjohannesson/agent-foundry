import { describe, expect, it } from "vitest";
import { deriveMono, nameFromPrompt, nameFromTitle } from "./names";

describe("nameFromPrompt", () => {
  it("drops filler words and keeps three", () => {
    expect(nameFromPrompt("Please migrate the Button to new tokens")).toBe("Migrate Button new");
  });
  it("falls back for empty prompts", () => {
    expect(nameFromPrompt("   ")).toBe("Untitled");
  });
});

describe("nameFromTitle", () => {
  it("keeps the title's words in order and trims to fit", () => {
    expect(nameFromTitle("Agentic controller for dark factory")).toBe("Agentic controller");
    expect(nameFromTitle("btw: how do loras work?")).toBe("btw: how do loras work?");
  });
  it("drops emoji and separators", () => {
    expect(nameFromTitle("🟣 M1 · transcript tailer and table view")).toBe("M1 transcript tailer");
  });
  it("cuts a single long word", () => {
    expect(nameFromTitle("Supercalifragilisticexpialidocious")).toBe("Supercalifragilisticexpi");
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
