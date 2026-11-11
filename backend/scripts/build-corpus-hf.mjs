// Builds reference-library files from Hugging Face datasets (via the public datasets-server API):
//   data/corpus/empathetic-dialogues.json  Estwld/empathetic_dialogues_llm (Meta EmpatheticDialogues, CC BY-NC 4.0)
//   data/corpus/synthetic-persona-chat.json google/Synthetic-Persona-Chat (CC BY 4.0)
//   data/corpus/daily-dialog.json           OpenRL/daily_dialog (mirror of DailyDialog, CC BY-NC-SA 4.0)
//   data/corpus/blended-skill-talk.json     ParlAI/blended_skill_talk (Meta)
//   data/corpus/movie-lines.json            spawn99/CornellMovieDialogCorpus (mirror of Cornell Movie-Dialogs)
//
//   node scripts/build-corpus-hf.mjs
//
// Like build-corpus.mjs: keeps short, on-topic, light exchanges and drops heavy or explicit topics.
import { writeFileSync } from "node:fs";

const API = "https://datasets-server.huggingface.co/rows";
const out = (name) => new URL(`../data/corpus/${name}`, import.meta.url);

async function rows(dataset, offset, length = 100, split = "train") {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${API}?dataset=${encodeURIComponent(dataset)}&config=default&split=${encodeURIComponent(split)}&offset=${offset}&length=${length}`);
    if (r.ok) return (await r.json()).rows.map((x) => x.row);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  return [];
}

async function pages(dataset, offsets, split = "train") {
  const all = [];
  for (let i = 0; i < offsets.length; i += 8) {
    const batch = await Promise.all(offsets.slice(i, i + 8).map((o) => rows(dataset, o, 100, split)));
    all.push(...batch.flat());
  }
  return all;
}

const BLOCK = /\b(abortion|misery|whining|hell|bed with|zipp|undress|bra|panties|fuck|shit|bitch|whore|slut|cock|dick|pussy|bastard|kill|murder|blood|sex|sexy|naked|nude|porn|kill|killed|die|died|dead|death|cancer|funeral|divorc|suicid|depress|drunk|drugs?|weed|gun|rape|abus|prison|jail|cheat\w*|passed away|miscarr|hospital|surgery|chemo|racis|nigg|fag|retard)\w*/i;
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/_comma_/g, ",").trim();
const STOP = new Set("i me my you your we it a an the and or but so to of in on at for with is am are was were be do did have has had that this what how not no yes just too very really like can will would about".split(" "));
const words = (s) => (s.toLowerCase().match(/[a-z']+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));


const TRANSACTION = /\d{3,}|\b(sir|madam|ma'am|customer|waiter|receipt|passport|reservation|account|bank|invoice|refund|dollars?|yuan|pounds|interview|resume|salary|department|manager|purchase|order|deposit|check-?in|luggage|ticket|apartment for rent|rent|loan|tax)\b|\$/i;

// ---- shared: keep the good (their message -> reply) pairs from a list of turns ----
function goodPairs(turnLists, { min = 15, max = 150, needLink = true } = {}) {
  const seen = new Set();
  const scored = [];
  for (const turns of turnLists) {
    for (let i = 0; i + 1 < turns.length; i++) {
      const them = clean(turns[i]), reply = clean(turns[i + 1]);
      if (them.length < min || them.length > 180 || reply.length < min || reply.length > max) continue;
      if (BLOCK.test(them) || BLOCK.test(reply) || /\[|\]|user \d/i.test(them + reply)) continue;
      const key = reply.toLowerCase().replace(/[^a-z]/g, "");
      if (seen.has(key)) continue;
      if (TRANSACTION.test(them + " " + reply)) continue; // customer service, phone numbers and other textbook chores
      const tw = new Set(words(them));
      const rw = words(reply);
      const overlap = rw.filter((w) => tw.has(w)).length;
      if (rw.length && overlap / rw.length > 0.5) continue; // parrots what they said
      if (reply.slice(0, 18).toLowerCase() === them.slice(0, 18).toLowerCase()) continue;
      const asks = /\?/.test(reply);
      if (needLink && overlap === 0 && !asks) continue;
      seen.add(key);
      const score = Math.min(overlap, 3) + (asks ? 2 : 0) + (/\b(lol|haha|ha|omg)\b|!/i.test(reply) ? 1 : 0)
        + (/\byou(r)?\b/i.test(reply) ? 1 : 0) - (reply.length > 110 ? 1 : 0);
      scored.push({ score, pair: [them, reply] });
    }
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.pair);
}
const save = (file, meta, pairs, n) => {
  writeFileSync(out(file), JSON.stringify({ ...meta, pairs: pairs.slice(0, n) }));
  console.log(`${file}: ${pairs.length} good pairs, ${Math.min(n, pairs.length)} saved`);
};
const spread = (total, count) => Array.from({ length: count }, (_, i) => Math.floor((i * total) / count / 100) * 100);
const only = process.argv[2]; // optional: build just one file, e.g. "daily"

// ---- Google Synthetic-Persona-Chat: two people with short bios getting to know each other ----
if (!only || only === "persona") {
  const raw = await pages("google/Synthetic-Persona-Chat", spread(8938, 90));
  const convs = raw.map((r) => String(r["Best Generated Conversation"] ?? "").split("\n").map((l) => l.replace(/^User \d:\s*/, "")).filter(Boolean));
  save("synthetic-persona-chat.json", {
    source: "https://huggingface.co/datasets/google/Synthetic-Persona-Chat",
    license: "CC BY 4.0",
    note: "Two people with short profile bios getting to know each other, like a new match.",
    kind: "chat",
  }, goodPairs(convs), 4000);
}

// ---- DailyDialog: clean human-written everyday chats ----
if (!only || only === "daily") {
  const raw = await pages("OpenRL/daily_dialog", spread(11118, 112));
  save("daily-dialog.json", {
    source: "https://huggingface.co/datasets/OpenRL/daily_dialog (mirror of li2017dailydialog/daily_dialog)",
    license: "CC BY-NC-SA 4.0 (non-commercial). Fine for personal use; replace before selling Rizzio.",
    note: "Clean everyday conversations: plans, small talk, dating and social life.",
    kind: "chat",
  }, goodPairs(raw.map((r) => (r.dialog ?? []).map((t) => t.replace(/\s+([,.?!'])/g, "$1").replace(/ ' /g, "'")))), 5000);
}

// ---- Blended Skill Talk: personality + empathy + engaging small talk ----
if (!only || only === "bst") {
  const raw = await pages("ParlAI/blended_skill_talk", spread(4819, 49));
  const convs = raw.map((r) => {
    const turns = [...(r.previous_utterance ?? [])];
    (r.free_messages ?? []).forEach((m, i) => turns.push(m, r.guided_messages?.[i] ?? ""));
    return turns.filter(Boolean);
  });
  save("blended-skill-talk.json", {
    source: "https://huggingface.co/datasets/ParlAI/blended_skill_talk",
    license: "Not stated on Hugging Face (released by Meta for research).",
    note: "Conversations that blend personality, empathy and knowledge to keep things flowing.",
    kind: "chat",
  }, goodPairs(convs), 4000);
}

// ---- Cornell Movie-Dialogs: snappy movie exchanges (strictly filtered, small sample) ----
if (!only || only === "movie") {
  const lines = await pages("spawn99/CornellMovieDialogCorpus", spread(304713, 200), "movie_lines");
  const byId = new Map(lines.map((l) => [Number(String(l.lineID).slice(1)), l]));
  const convs = [];
  for (const [id, l] of byId) {
    const next = byId.get(id + 1); // the corpus numbers lines in order within a scene
    if (next && next.movieID === l.movieID && next.characterID !== l.characterID) convs.push([l.utterance, next.utterance]);
  }
  save("movie-lines.json", {
    source: "https://huggingface.co/datasets/spawn99/CornellMovieDialogCorpus (mirror of Cornell Movie-Dialogs)",
    license: "No clear license; movie lines belong to their studios. Personal use only; remove before selling Rizzio.",
    note: "Snappy, playful exchanges between movie characters. For rhythm and wit only.",
    kind: "movie",
  }, goodPairs(convs, { min: 10, max: 120, needLink: false }).filter(([t, r]) => /[?!]/.test(r) || words(r).some((w) => words(t).includes(w))), 1500);
}

if (!only || only === "empathy") {
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
}
