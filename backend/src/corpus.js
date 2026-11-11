// Reference library: good exchanges from public datasets and Rizzio's own playbook (data/corpus/*.json).
// At reply time we pick the few most relevant to what's on screen and show them to the model as examples
// of how good replies pick up on details and keep things going. They're never the user's voice: the
// user's own uploads (Train) decide how replies sound.
import { readdirSync, readFileSync } from "node:fs";

const DIR = new URL("../data/corpus/", import.meta.url);
const STOP = new Set("i me my you your yours we our it its a an the and or but so to of in on at for with is am are was were be been do does did have has had that this what how who not no yes just too very really like can will would about from up out all get got im i'm it's thats that's i've i'll you're don't dont".split(" "));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, "");
export const tokens = (s) => [...new Set((String(s).toLowerCase().match(/[a-z']+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem))];

function load() {
  const docs = [];
  for (const f of readdirSync(DIR).filter((n) => n.endsWith(".json")).sort()) {
    const set = JSON.parse(readFileSync(new URL(f, DIR), "utf8"));
    for (const [them, reply, emotion] of set.pairs) {
      docs.push({ them, reply, emotion, kind: set.kind ?? "chat", language: set.language ?? "en", source: set.source, toks: tokens(them) });
    }
  }
  const df = new Map();
  for (const d of docs) for (const t of d.toks) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t) => Math.log(1 + docs.length / (df.get(t) ?? 1));
  const byToken = new Map();
  docs.forEach((d, i) => d.toks.forEach((t) => (byToken.get(t) ?? byToken.set(t, []).get(t)).push(i)));
  return { docs, idf, byToken };
}

// Common romanized Hindi words: if a conversation has a few, it's Hinglish and Hinglish examples are used.
const HINGLISH = new Set("hai hain kya nahi nhi yaar yar bhai mein tum tu kaise kaisa kaisi kab kahan kyun kyu acha accha achha haan arre aaj kal mera meri mere tera teri tere bohot bahut kuch sab gaya gayi raha rahi karo kar wala wali hoga hogi matlab chal dekh suno bata batao abhi phir".split(" "));
export function isHinglish(text) {
  const words = String(text ?? "").toLowerCase().match(/[a-z]+/g) ?? [];
  const hits = words.filter((w) => HINGLISH.has(w)).length;
  return hits >= 2 && hits / words.length >= 0.12;
}

let library;
export const corpus = () => (library ??= load());

/**
 * The `limit` exchanges most related to `text` (shared, rarer words count more), mixing
 * dating-profile examples in for profile requests. No text (e.g. screenshot only): a fixed sample.
 */
export function inspiration(text, { limit = 6, mode = "auto" } = {}) {
  const { docs, idf, byToken } = corpus();
  const q = tokens(text ?? "");
  const wantPrompt = mode === "prompt" || mode === "auto";
  const hinglish = isHinglish(text);
  const scores = new Map();
  for (const t of q) {
    for (const i of byToken.get(t) ?? []) {
      if ((docs[i].language === "hinglish") !== hinglish) continue; // Hinglish examples only for Hinglish chats, and vice versa
      scores.set(i, (scores.get(i) ?? 0) + idf(t));
    }
  }
  const ranked = [...scores.entries()]
    .map(([i, s]) => {
      let score = s / Math.sqrt(docs[i].toks.length + 2);
      if (wantPrompt && docs[i].kind === "prompt") score += 0.5;
      if (mode === "prompt" && docs[i].kind === "empathy") score *= 0.5; // profiles want play, not consoling
      return [i, score];
    })
    .sort((a, b) => b[1] - a[1]);
  const out = [];
  const used = new Set();
  const perSource = new Map();
  const cap = Math.max(2, Math.ceil(limit / 2)); // mix sources: no single dataset fills every slot
  for (const [i] of ranked) {
    if (out.length >= limit) break;
    const key = docs[i].reply.slice(0, 20);
    if (used.has(key) || (perSource.get(docs[i].source) ?? 0) >= cap) continue;
    used.add(key);
    perSource.set(docs[i].source, (perSource.get(docs[i].source) ?? 0) + 1);
    out.push(docs[i]);
  }
  // Pad with dating-profile examples (for profiles) or the top chat examples, in a stable order.
  const fallback = docs.filter((x) => (x.language === "hinglish") === hinglish && (!wantPrompt || hinglish || x.kind === "prompt"));
  for (let i = 0; out.length < limit && i < fallback.length; i++) {
    if (!out.includes(fallback[i])) out.push(fallback[i]);
  }
  return out.map(({ them, reply, kind, emotion }) => ({ them, reply, kind, ...(emotion ? { emotion } : {}) }));
}

export function renderInspiration(examples) {
  if (!examples.length) return "";
  return (
    "## Reference exchanges (from Rizzio's library, NOT the user's voice)\n" +
    "Examples of replies that pick up on a detail and keep things going. Use them only for ideas about angle and flow. " +
    "Never copy their wording, and never let them change how the user sounds.\n" +
    examples
      .map((e) => {
        const label = e.kind === "prompt" ? "Profile" : e.kind === "empathy" ? `They shared (feeling ${e.emotion ?? "something"})` : "They said";
        return `- ${label}: "${e.them}" → Reply: "${e.reply}"`;
      })
      .join("\n")
  );
}
