// Builds two more reference-library files from Hugging Face datasets (via the public datasets-server API):
//   data/corpus/hinglish-everyday.json   from Abhishekcr448/Hinglish-Everyday-Conversations-1M (MIT)
//   data/corpus/empathetic-dialogues.json from Estwld/empathetic_dialogues_llm (Meta's EmpatheticDialogues, CC BY-NC 4.0)
//
//   node scripts/build-corpus-hf.mjs
//
// Like build-corpus.mjs: keeps short, on-topic, light exchanges and drops heavy or explicit topics.
import { writeFileSync } from "node:fs";

const API = "https://datasets-server.huggingface.co/rows";
const out = (name) => new URL(`../data/corpus/${name}`, import.meta.url);

async function rows(dataset, offset, length = 100, split = "train") {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${API}?dataset=${encodeURIComponent(dataset)}&config=default&split=${split}&offset=${offset}&length=${length}`);
    if (r.ok) return (await r.json()).rows.map((x) => x.row);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  return [];
}

async function pages(dataset, offsets) {
  const all = [];
  for (let i = 0; i < offsets.length; i += 8) {
    const batch = await Promise.all(offsets.slice(i, i + 8).map((o) => rows(dataset, o)));
    all.push(...batch.flat());
  }
  return all;
}

const BLOCK = /\b(sex|sexy|naked|nude|porn|kill|killed|die|died|dead|death|cancer|funeral|divorc|suicid|depress|drunk|drugs?|weed|gun|rape|abus|prison|jail|cheat\w*|passed away|miscarr|hospital|surgery|chemo|racis|nigg|fag|retard)\w*/i;
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/_comma_/g, ",").trim();
const STOP = new Set("i me my you your we it a an the and or but so to of in on at for with is am are was were be do did have has had that this what how not no yes just too very really like can will would about".split(" "));
const words = (s) => (s.toLowerCase().match(/[a-z']+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));

// ---- Hinglish everyday banter: 1M rows; sample spread across the whole set ----
{
  const offsets = Array.from({ length: 120 }, (_, i) => Math.floor((i * 1_000_000) / 120));
  const raw = await pages("Abhishekcr448/Hinglish-Everyday-Conversations-1M", offsets);
  const seen = new Set();
  const pairs = [];
  for (const r of raw) {
    const them = clean(r.input), reply = clean(r.output);
    if (them.length < 8 || them.length > 140 || reply.length < 8 || reply.length > 140) continue;
    if (BLOCK.test(them) || BLOCK.test(reply)) continue;
    const key = reply.toLowerCase().replace(/[^a-z]/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([them, reply]);
  }
  writeFileSync(out("hinglish-everyday.json"), JSON.stringify({
    source: "https://huggingface.co/datasets/Abhishekcr448/Hinglish-Everyday-Conversations-1M",
    license: "MIT",
    note: "Synthetic casual Hinglish (Hindi-English) banter between two people. Used only when the conversation itself is in Hinglish.",
    kind: "chat",
    language: "hinglish",
    pairs: pairs.slice(0, 5000),
  }));
  console.log(`hinglish: ${raw.length} rows read, ${pairs.length} kept, ${Math.min(pairs.length, 5000)} saved`);
}

// ---- EmpatheticDialogues: every train conversation; take (their message -> warm reply) turns ----
{
  const total = 19533;
  const offsets = Array.from({ length: Math.ceil(total / 100) }, (_, i) => i * 100);
  const raw = await pages("Estwld/empathetic_dialogues_llm", offsets);
  const seen = new Set();
  const scored = [];
  for (const conv of raw) {
    const turns = conv.conversations ?? [];
    if (BLOCK.test(clean(conv.situation))) continue;
    for (let i = 0; i + 1 < turns.length; i++) {
      if (turns[i].role !== "user" || turns[i + 1].role !== "assistant") continue;
      const them = clean(turns[i].content), reply = clean(turns[i + 1].content);
      if (them.length < 20 || them.length > 180 || reply.length < 20 || reply.length > 150) continue;
      if (BLOCK.test(them) || BLOCK.test(reply)) continue;
      const key = reply.toLowerCase().replace(/[^a-z]/g, "");
      if (seen.has(key)) continue;
      const tw = new Set(words(them));
      const overlap = words(reply).filter((w) => tw.has(w)).length;
      const asks = /\?/.test(reply);
      if (overlap === 0 && !asks) continue; // must respond to what they said
      seen.add(key);
      scored.push({ score: overlap * 2 + (asks ? 2 : 0) + (/!/.test(reply) ? 0.5 : 0), them, reply, emotion: conv.emotion });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const keep = scored.slice(0, 6000);
  writeFileSync(out("empathetic-dialogues.json"), JSON.stringify({
    source: "https://huggingface.co/datasets/Estwld/empathetic_dialogues_llm (Meta EmpatheticDialogues)",
    license: "CC BY-NC 4.0 (non-commercial). Fine for personal use; replace before selling Rizzio.",
    note: "Someone shares a feeling (proud, nervous, sad, excited...) and the reply picks up on it. Shows how to answer emotional cues warmly.",
    kind: "empathy",
    pairs: keep.map(({ them, reply, emotion }) => [them, reply, emotion]),
  }));
  console.log(`empathetic: ${raw.length} conversations read, ${scored.length} turns kept, ${keep.length} saved`);
}
