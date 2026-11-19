/**
 * Names and monograms.
 * A name is a short human label ("Button tokens"). The monogram is two letters
 * shown on slots and on the map ("Bt"), unique within a workstream.
 */

const STOP = new Set(["the", "a", "an", "to", "of", "for", "and", "in", "on", "with", "please", "can", "you", "could", "i", "we", "let's", "lets", "let", "us", "me", "my", "our", "is", "be", "it", "this", "that", "into", "from", "by", "at", "as", "so", "some", "all", "up", "out"]);

/** A provisional name from a prompt, used until a controller or you names the session. */
export function nameFromPrompt(prompt: string, maxWords = 3, maxLen = 24): string {
  const words = prompt
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_#>\[\](){}]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}\-.]/gu, ""))
    .filter((w) => w.length > 0 && !STOP.has(w.toLowerCase()));
  let out = "";
  for (const w of words.slice(0, maxWords)) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > maxLen) break;
    out = next;
  }
  if (!out) return "Untitled";
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * A name from the app's title ("Agentic controller for dark factory" -> "Agentic controller").
 * Titles are already written for people, so it keeps their words in order and only trims to fit.
 */
export function nameFromTitle(title: string, maxLen = 24): string {
  const words = title
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)) // drop emoji and lone separators like "·"
    .map((w, i) => (i === 0 ? w.replace(/^[^\p{L}\p{N}]+/u, "") : w));
  let out: string[] = [];
  for (const w of words) {
    if ([...out, w].join(" ").length > maxLen) break;
    out.push(w);
  }
  if (out.length === 0 && words[0]) out = [words[0].slice(0, maxLen)];
  while (out.length > 1 && STOP.has(out.at(-1)!.toLowerCase().replace(/[^\p{L}']/gu, ""))) out.pop();
  const name = out.join(" ").replace(/[,:;·\-–—]+$/u, "");
  return name || "Untitled";
}

/** Two letters: first letters of the first two words, or the first two letters of a single word. Avoids `taken`. */
export function deriveMono(name: string, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  const letters = name.replace(/[^\p{L}\p{N}\s]/gu, "").trim();
  const words = letters.split(/\s+/).filter(Boolean);
  const fmt = (a: string, b: string) => a.toUpperCase() + b.toLowerCase();
  const candidates: string[] = [];
  const first = words[0] ?? "X";
  if (words.length > 1) candidates.push(fmt(first[0]!, words[1]![0]!));
  for (const ch of first.slice(1)) candidates.push(fmt(first[0]!, ch));
  for (const w of words.slice(1)) for (const ch of w) candidates.push(fmt(first[0]!, ch));
  for (const c of candidates) if (!used.has(c.toLowerCase())) return c;
  for (let i = 2; i < 100; i++) { const c = first[0]!.toUpperCase() + String(i).slice(-1); if (!used.has(c.toLowerCase())) return c; }
  return fmt(first[0]!, "x");
}
