// Builds backend/data/corpus/the-rizz-corpus.json from the Hugging Face dataset
// https://huggingface.co/datasets/the-rizz/the-rizz-corpus (one Llama-2-style text file).
//
//   git clone https://huggingface.co/datasets/the-rizz/the-rizz-corpus /tmp/the-rizz-corpus
//   node scripts/build-corpus.mjs /tmp/the-rizz-corpus/the-rizz-corpus.txt
//
// Keeps the best short, on-topic, family-friendly exchanges (their message → a good reply), drops
// non-sequiturs, sad or explicit topics, and duplicates. The output is checked in and used by
// src/corpus.js as reference examples of how good conversations flow (never as the user's voice).
import { readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2];
if (!src) throw new Error("usage: node scripts/build-corpus.mjs path/to/the-rizz-corpus.txt");
const raw = readFileSync(src, "utf8");

const STOP = new Set("i me my you your yours we our it its a an the and or but so to of in on at for with is am are was were be been do does did have has had that this what how who not no yes just too very really like can will would about from up out all get got im i'm it's thats that's".split(" "));
const words = (s) => (s.toLowerCase().match(/[a-z']+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, "");

const BLOCK = /\b(sex|sexy|naked|nude|porn|kill|killed|die|died|dead|death|cancer|funeral|divorc|suicid|depress|drunk|drugs?|weed|gun|guns|hate|stupid|ugly|fat|religio|church|christian|god|jesus|politic|trump|democrat|republican|abus|rape|disease|sick|hospital|cheat|broke up|left me|passed away|lost my|wheelchair|blind|deaf|orphan|adopted|prison|jail|weight|diet)\w*/i;
const NONSENSE = /(not making sense|i don't understand|what do you mean|sorry\?|huh\?|as an ai|i am a bot|<|>|\[|\])/i;

const pairs = [];
let prev = null;
for (const line of raw.split("\n")) {
  if (line.startsWith("<<SYS>>") || line.startsWith("Here are") || line.startsWith("Remember")) { prev = null; continue; }
  const m = /<s>\[INST\]\s*(.+?)\s*\[\/INST\]\s*(.+?)\s*<\/s>/.exec(line);
  if (!m) continue;
  const [, them, reply] = m;
  pairs.push({ them: them.trim(), reply: reply.trim(), before: prev });
  prev = reply.trim();
}

const seen = new Set();
const scored = [];
for (const p of pairs) {
  const { them, reply } = p;
  if (them.length < 12 || them.length > 180 || reply.length < 18 || reply.length > 150) continue;
  if (BLOCK.test(them) || BLOCK.test(reply) || NONSENSE.test(them) || NONSENSE.test(reply)) continue;
  if (/\b(\w+) \1\b/i.test(reply)) continue; // stutters like "the the"
  const key = reply.toLowerCase().replace(/[^a-z]/g, "");
  if (seen.has(key)) continue;
  const tw = new Set(words(them).map(stem));
  const rw = words(reply).map(stem);
  const overlap = rw.filter((w) => tw.has(w)).length;
  const asks = /\?\s*$/.test(reply) || /\?/.test(reply);
  const playful = /\b(lol|haha|lmao|ha|omg|wow|nice|awesome|fun|love|favorite|fav)\b|!/.test(reply.toLowerCase());
  // Must actually respond to what they said: share a topic word, or ask about it.
  if (overlap === 0 && !(asks && /^(that|what|how|oh|wow|really|nice|cool|awesome|sounds|i love|me too)/i.test(reply))) continue;
  const score = overlap * 2 + (asks ? 3 : 0) + (playful ? 1 : 0) + (reply.length >= 30 && reply.length <= 110 ? 1 : 0) + (/^[A-Z]/.test(reply) ? 0.5 : 0);
  seen.add(key);
  scored.push({ score, them, reply });
}
scored.sort((a, b) => b.score - a.score);
const keep = scored.slice(0, 5000).map(({ them, reply }) => [them, reply]);

writeFileSync(
  new URL("../data/corpus/the-rizz-corpus.json", import.meta.url),
  JSON.stringify({
    source: "https://huggingface.co/datasets/the-rizz/the-rizz-corpus",
    note: "Getting-to-know-you chats on a social app (PersonaChat style). Filtered for short, on-topic, light exchanges. Reference only: shows how good replies pick up on what was said and keep things going.",
    license: "No license stated on the dataset page (checked 2026-11-08).",
    kind: "chat",
    pairs: keep,
  }),
);
console.log(`parsed ${pairs.length} exchanges, ${scored.length} passed filters, kept ${keep.length}`);
