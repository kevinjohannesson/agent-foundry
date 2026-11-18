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
