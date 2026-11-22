// Picking the replies the user sees, and learning their taste.
//
// The reply model writes ~10 candidates. A judge scores each 1-10 (misread, generic, invented
// facts, not the user...). Then a small per-user ranking model (logistic regression, like
// dating-assist's on-phone opener model) adds a boost learned from what this user picks, edits,
// rejects and what gets matches. Its say grows with the number of signals.

import { REPLY_FORMS } from "./ai.js";
import { OPENERS, phrasesIn } from "./prompts.js";

export const MAX_SHOWN = 5;
export const MIN_SHOWN = 3;
/** A candidate needs this judge score to be shown (unless fewer than MIN_SHOWN pass). */
export const PASS_SCORE = 6;
const QUESTION_FORMS = new Set(["follow_up_question", "answer_and_ask"]);

// ---------- features ----------

const LENGTHS = [["len_short", 0, 6], ["len_medium", 7, 14], ["len_long", 15, 25], ["len_very_long", 26, Infinity]];
const EMOJI = /\p{Extended_Pictographic}/u;

/** What a reply looks like, as named 0/1 features. */
export function features(reply) {
  const text = String(reply?.text ?? "");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const f = { bias: 1 };
  if (REPLY_FORMS.includes(reply?.form)) f[`form_${reply.form}`] = 1;
  for (const [name, lo, hi] of LENGTHS) if (words >= lo && words <= hi) f[name] = 1;
  if (text.includes("?")) f.question = 1;
  if (EMOJI.test(text)) f.emoji = 1;
  if (/!/.test(text)) f.exclamation = 1;
  if (phrasesIn(text.split(/[.,!?]/)[0] ?? "", OPENERS).length) f.opener = 1;
  if (/^[a-z]/.test(text.trim())) f.lowercase = 1;
  return f;
}

// ---------- the per-user model ----------

/** How much each kind of signal counts, and which way. */
export const SIGNAL_WEIGHTS = {
  picked: { target: 1, weight: 1 },
  edited: { target: 1, weight: 0.6 }, // liked it enough to send, but changed it
  rejected: { target: 0, weight: 1 }, // "Not me"
  match: { target: 1, weight: 2 }, // it worked: strongest signal
  replied: { target: 1, weight: 2 },
  ignored: { target: 0, weight: 1 },
};
/** The other replies in a set the user picked from count as a weak "not this". */
const PASSED_OVER = { target: 0, weight: 0.25 };
const LEARNING_RATE = 0.15;
const L2 = 0.002;
/** The model's share of the ranking grows to MAX_SHARE at FULL_SIGNALS signals. */
const MAX_SHARE = 0.6;
const FULL_SIGNALS = 150;

export const emptyTaste = () => ({ weights: {}, signals: 0 });

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const dot = (w, f) => Object.entries(f).reduce((s, [k, v]) => s + (w[k] ?? 0) * v, 0);

function step(taste, f, target, weight) {
  const err = sigmoid(dot(taste.weights, f)) - target;
  for (const [k, v] of Object.entries(f)) {
    const w = taste.weights[k] ?? 0;
    taste.weights[k] = w - LEARNING_RATE * weight * (err * v + L2 * w);
  }
}

/** Learns from one signal on a generation's replies. Returns the updated taste (a copy). */
export function learn(taste, kind, replies, replyIndex) {
  const rule = SIGNAL_WEIGHTS[kind];
  const reply = replies?.[replyIndex];
  if (!rule || !reply) return taste;
  const next = { weights: { ...(taste?.weights ?? {}) }, signals: (taste?.signals ?? 0) + 1 };
  step(next, features(reply), rule.target, rule.weight);
  if (kind === "picked") {
    replies.forEach((r, i) => { if (i !== replyIndex) step(next, features(r), PASSED_OVER.target, PASSED_OVER.weight); });
  }
  return next;
}

/** How much the taste model counts right now (0 to MAX_SHARE). */
export const tasteShare = (taste) => Math.min(MAX_SHARE, ((taste?.signals ?? 0) / FULL_SIGNALS) * MAX_SHARE);

/** Score adjustment (in judge points, about -1.8 to +1.8 at full share) for one reply. */
export function tasteBoost(taste, reply) {
  const share = tasteShare(taste);
  if (!share) return 0;
  return (sigmoid(dot(taste.weights, features(reply))) - 0.5) * 6 * share;
}

const LABELS = {
  question: "replies that ask a question", emoji: "emoji", exclamation: "exclamation marks", opener: "starting with words like \"ok but\" or \"lol\"",
  lowercase: "all-lowercase replies", len_short: "very short replies", len_medium: "short replies", len_long: "medium-length replies", len_very_long: "long replies",
};
const label = (k) => LABELS[k] ?? (k.startsWith("form_") ? `${k.slice(5).replace(/_/g, " ")}s` : k);

/** What the model has learned, in words, for the app. */
export function describeTaste(taste) {
  const entries = Object.entries(taste?.weights ?? {}).filter(([k, w]) => k !== "bias" && Math.abs(w) >= 0.15).sort((a, b) => b[1] - a[1]);
  return {
    signals: taste?.signals ?? 0,
    share: Math.round(tasteShare(taste) * 100),
    likes: entries.filter(([, w]) => w > 0).slice(0, 4).map(([k]) => label(k)),
    dislikes: entries.filter(([, w]) => w < 0).reverse().slice(0, 4).map(([k]) => label(k)),
  };
}

// ---------- choosing what to show ----------

/**
 * Picks up to MAX_SHOWN of the candidates: by judge score, minus a penalty per stock phrase,
 * plus the user's taste. Keeps at least one question back if a good one exists, and shows
 * fewer (down to MIN_SHOWN) rather than padding with weak ones.
 * Returns the chosen replies, best first, each with its `score`.
 */
export function choose(candidates, { scores = null, flags = [], taste = null } = {}) {
  const rows = candidates.map((r, i) => {
    // No judge (it failed, or too few candidates): keep the model's own order; flagged ones get rewritten later.
    const judge = scores?.[i]?.score ?? 10 - i * 0.1;
    const total = judge - (scores ? 1.5 * (flags[i]?.length ?? 0) : 0) + tasteBoost(taste, r);
    return { r, i, judge, total, issue: scores?.[i]?.issue ?? "" };
  });
  const seen = new Set();
  const ranked = rows.sort((a, b) => b.total - a.total).filter((x) => {
    const key = x.r.text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const passing = ranked.filter((x) => x.judge >= PASS_SCORE);
  let picked = (passing.length >= MIN_SHOWN ? passing : ranked).slice(0, Math.max(MIN_SHOWN, Math.min(MAX_SHOWN, passing.length)));
  const isQ = (x) => QUESTION_FORMS.has(x.r.form) || x.r.text.includes("?");
  if (!picked.some(isQ)) {
    const q = ranked.find((x) => isQ(x) && x.judge >= PASS_SCORE && !picked.includes(x));
    if (q) picked = [...picked.slice(0, picked.length - 1), q];
  }
  return picked.map((x) => ({ ...x.r, score: Math.round(x.judge * 10) / 10 }));
}
