// The persona: how the user wants Rizzio to sound, set with sliders in the app.
// Every slider is 0-100. The iOS app has a matching list (ios/Shared/Persona.swift); keep the keys in sync.

export const SLIDERS = [
  // key, left label (0), right label (100), default
  { key: "flirt", left: "friendly, no flirting", right: "openly flirty", def: 55 },
  { key: "humor", left: "sincere", right: "joking around", def: 65 },
  { key: "humorStyle", left: "goofy and silly", right: "dry and deadpan", def: 50 },
  { key: "boldness", left: "easygoing and safe", right: "bold and daring", def: 55 },
  { key: "tease", left: "supportive", right: "playfully teasing", def: 45 },
  { key: "warmth", left: "cool and aloof", right: "warm and affectionate", def: 60 },
  { key: "spice", left: "strictly PG", right: "cheeky innuendo (never explicit)", def: 25 },
  { key: "length", left: "a few words", right: "a couple of sentences", def: 35 },
  { key: "emoji", left: "no emoji", right: "lots of emoji", def: 15 },
  { key: "polish", left: "casual texting", right: "polished and proper", def: 25 },
  { key: "curiosity", left: "statements", right: "always ends with a question", def: 60 },
  { key: "pace", left: "slow burn", right: "moves fast toward a date", def: 40 },
];

export const TOGGLES = [
  { key: "lowercase", text: "Write in all lowercase." },
  { key: "noEmoji", text: "Never use emoji (text emoticons like :) are fine only if the user writes them)." },
  { key: "noPhotos", text: "Ignore their photos completely: reply only to their written prompts, profile text and messages. Never mention, describe or guess from what's in their pictures or how they look, and never pick a photo as the hook." },
  { key: "noPickupLines", text: "Never use canned pickup lines or cheesy puns." },
  { key: "mirrorEnergy", text: "Mirror the other person's energy and message length." },
  { key: "useMyInterests", text: "Work in the user's own interests and life details when it fits." },
  { key: "noDoubleText", text: "Never write anything needy or chasing (no 'hello??', no guilt trips)." },
];

export const GOALS = {
  match: "Get the match: stand out and make them want to reply.",
  keepGoing: "Keep the conversation going and build rapport.",
  number: "Move toward swapping numbers or socials, when it's natural.",
  date: "Move toward setting up a date, when it's natural.",
  friend: "Just be a good friend: supportive, fun, genuine.",
};

export const DEFAULT_PERSONA = {
  sliders: Object.fromEntries(SLIDERS.map((s) => [s.key, s.def])),
  toggles: { lowercase: false, noEmoji: false, noPhotos: false, noPickupLines: true, mirrorEnergy: true, useMyInterests: true, noDoubleText: true },
  goal: "match",
  avoid: "",
  notes: "",
};

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** Accepts anything, returns a clean persona (unknown keys dropped, values clamped, defaults filled in). */
export function sanitizePersona(raw, base = DEFAULT_PERSONA) {
  const out = structuredClone(base);
  if (!raw || typeof raw !== "object") return out;
  for (const s of SLIDERS) {
    const v = raw.sliders?.[s.key];
    if (typeof v === "number" && Number.isFinite(v)) out.sliders[s.key] = clamp(v);
  }
  for (const t of TOGGLES) {
    const v = raw.toggles?.[t.key];
    if (typeof v === "boolean") out.toggles[t.key] = v;
  }
  if (typeof raw.goal === "string" && raw.goal in GOALS) out.goal = raw.goal;
  if (typeof raw.avoid === "string") out.avoid = raw.avoid.slice(0, 300);
  if (typeof raw.notes === "string") out.notes = raw.notes.slice(0, 500);
  return out;
}

function band(v) {
  if (v <= 10) return "fully";
  if (v <= 35) return "mostly";
  if (v < 65) return "balanced between";
  if (v < 90) return "mostly";
  return "fully";
}

/** Turns the sliders into instructions the reply model follows. */
export function renderPersona(persona) {
  const p = sanitizePersona(persona);
  const lines = [];
  for (const s of SLIDERS) {
    if (s.key === "emoji" && p.toggles.noEmoji) {
      lines.push("- emoji: OFF. The user turned emoji off: no emoji at all in any reply.");
      continue;
    }
    const v = p.sliders[s.key];
    const where =
      v < 35 ? `${band(v)} ${s.left}` : v < 65 ? `balanced between ${s.left} and ${s.right}` : `${band(v)} ${s.right}`;
    lines.push(`- ${s.key}: ${v}/100 (0 = ${s.left}, 100 = ${s.right}) → ${where}`);
  }
  const rules = TOGGLES.filter((t) => p.toggles[t.key]).map((t) => `- ${t.text}`);
  const parts = [
    "## Persona settings (the user set these with sliders; follow them closely)",
    lines.join("\n"),
  ];
  if (rules.length) parts.push("Rules:\n" + rules.join("\n"));
  parts.push(`Goal: ${GOALS[p.goal]}`);
  if (p.avoid.trim()) parts.push(`Never bring up: ${p.avoid.trim()}`);
  if (p.notes.trim()) parts.push(`The user's extra instructions: ${p.notes.trim()}`);
  parts.push(
    "When these settings and the user's learned voice disagree on style details (length, emoji, capitalization), follow the settings: the user chose them on purpose.",
  );
  return parts.join("\n\n");
}

// Emoji, skin tones, flags, keycaps and the joiners that glue them together.
const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}])+/gu;

/** Removes emoji from a reply (for the "No emoji" toggle), tidying the spaces left behind. */
export function stripEmoji(text) {
  return text.replace(EMOJI, "").replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?])/g, "$1").trim();
}

/** Applies the persona's hard rules to finished replies, so they hold even if the model slips. */
export function enforcePersona(persona, replies) {
  const p = sanitizePersona(persona);
  return replies.map((r) => {
    let text = r.text;
    if (p.toggles.noEmoji) text = stripEmoji(text);
    if (p.toggles.lowercase) text = text.toLowerCase();
    return { ...r, text };
  }).filter((r) => r.text);
}
