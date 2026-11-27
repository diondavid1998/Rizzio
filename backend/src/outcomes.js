// Closing the loop: did a line Rizzio wrote actually work?
// When a later chat screenshot shows one of the user's sent messages matching a reply Rizzio wrote
// (even lightly edited) and the other person answered after it, that's a real result: the comment
// got a match (profile comments) or the message got a reply (chats).

const words = (s) => String(s ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? [];

/** 0..1: how much two messages are the same message (shared words over the longer one). */
export function sameMessage(a, b) {
  const x = words(a);
  const y = new Set(words(b));
  if (!x.length || !y.size) return 0;
  const shared = new Set(x.filter((w) => y.has(w))).size;
  return shared / Math.max(new Set(x).size, y.size);
}

const MATCH = 0.6; // allows small edits before sending
const WINDOW_DAYS = 30;

/**
 * transcript: [{ from: "me" | "them", text }] top to bottom.
 * history: generations (newest first) with replies and signals, as store.history returns them.
 * Returns the results to record: [{ generationId, replyIndex, kind: "match" | "replied", text }].
 */
export function findOutcomes(transcript, history, now = Date.now()) {
  const lines = (transcript ?? []).filter((l) => l && typeof l.text === "string" && l.text.trim() && (l.from === "me" || l.from === "them"));
  const recent = history.filter((g) => now - Date.parse(`${g.createdAt}Z`) < WINDOW_DAYS * 86_400_000);
  const found = [];
  const seen = new Set();
  lines.forEach((line, i) => {
    if (line.from !== "me" || !lines.slice(i + 1).some((l) => l.from === "them")) return; // they answered after it
    let best = null;
    for (const g of recent) {
      g.replies.forEach((r, k) => {
        const score = sameMessage(line.text, r.text);
        if (score >= MATCH && (!best || score > best.score)) best = { g, k, score };
      });
    }
    if (!best) return;
    const key = `${best.g.id}:${best.k}`;
    const already = best.g.signals.some((s) => s.replyIndex === best.k && (s.kind === "match" || s.kind === "replied"));
    if (already || seen.has(key)) return;
    seen.add(key);
    found.push({ generationId: best.g.id, replyIndex: best.k, kind: best.g.mode === "prompt" ? "match" : "replied", text: line.text.trim() });
  });
  return found;
}
