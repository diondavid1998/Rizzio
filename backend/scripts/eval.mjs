#!/usr/bin/env node
// Rizzio eval: runs fixed test cases (eval/cases.json) against a Rizzio server and scores the results,
// so a change to the prompts or the pipeline can be measured instead of eyeballed.
//
//   node scripts/eval.mjs                         # all cases, Premium, against $RIZZIO_URL
//   node scripts/eval.mjs --plus                  # Premium Plus
//   node scripts/eval.mjs --only askout,boundary  # some cases (ids or id prefixes)
//   node scripts/eval.mjs --replay my-chats.jsonl # replay test with your own chats (see below)
//
// Env: RIZZIO_URL (default http://localhost:4000), APP_TOKEN (if the server has one).
// Requests are previews from a throwaway user, so nothing is learned or saved.
// Each case costs one reply request (~0.4 cents on Premium, ~5 cents on Plus).
//
// Replay test (text-like-me's idea): a JSON Lines file of {"context": "...chat up to their last message...",
// "real": "what you actually sent"}. Rizzio writes replies for each context; the report compares them with
// what you really sent (length, capitalization, punctuation, emoji, shared words) and prints them side by side.
// Keep that file OUT of the repo (eval/private/ is git-ignored): it's your private messages.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = (process.env.RIZZIO_URL ?? "http://localhost:4000").replace(/\/$/, "");
const USER = `eval-${Math.random().toString(36).slice(2, 10)}`;
const persona = { me: opt("me") ?? "man", into: opt("into") ?? "women" };
const STOCK = /\b(bold (pick|move|claim|take|choice)|i respect|respectfully|sweet spot|elite|iconic|a whole vibe|die on that hill|i'?m impressed|genuinely|underrated|the way you|something about you)\b/i;

async function reply(body) {
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/replies`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rizzio-user": USER,
      ...(process.env.APP_TOKEN ? { authorization: `Bearer ${process.env.APP_TOKEN}` } : {}),
      ...(flag("plus") ? { "x-rizzio-tier": "plus" } : {}),
    },
    body: JSON.stringify({ preview: true, persona, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return { ...json, ms: Date.now() - started };
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");

async function runCases() {
  const { cases } = JSON.parse(readFileSync(new URL("../eval/cases.json", import.meta.url), "utf8"));
  const only = opt("only")?.split(",");
  const picked = only ? cases.filter((c) => only.some((o) => c.id.startsWith(o))) : cases;
  const rows = [];
  for (const c of picked) {
    try {
      const r = await reply({ mode: c.mode, text: c.text });
      const texts = r.replies.map((x) => x.text);
      const bad = (c.mustNot ?? []).flatMap((re) => texts.filter((t) => new RegExp(re, "i").test(t)).map((t) => `/${re}/ in "${t}"`));
      const stock = texts.filter((t) => STOCK.test(t));
      // A list answer ("matcha and horror movies"): at most N replies may cram every item into one line.
      if (c.maxCombined != null) {
        const items = c.text.split("\n").slice(-1)[0].split(/,| and /i).map((x) => x.trim().toLowerCase().split(" ")[0]).filter(Boolean);
        const combined = texts.filter((t) => items.every((w) => t.toLowerCase().includes(w)));
        if (combined.length > c.maxCombined) bad.push(`${combined.length} replies combine every item (max ${c.maxCombined})`);
      }
      const kindOk = !c.kind || c.kind.includes(r.read?.kind);
      const stageOk = (!c.stage || c.stage.includes(r.read?.stage)) && (!c.sideTopic || r.read?.side_topic === c.sideTopic);
      const scores = r.replies.map((x) => x.score).filter((s) => typeof s === "number");
      const row = {
        id: c.id, kind: r.read?.kind, kindOk, stage: r.read?.stage, stageOk, shown: texts.length,
        avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        overLimit: c.mode === "prompt" ? texts.filter((t) => t.length > 150).length : 0,
        bad, stock, ms: r.ms, play: r.read?.play, replies: texts,
      };
      rows.push(row);
      const ok = kindOk && stageOk && !bad.length && !stock.length;
      console.log(`${ok ? "PASS" : "FAIL"}  ${c.id.padEnd(20)} kind=${row.kind}${kindOk ? "" : " (expected " + c.kind.join("/") + ")"}${c.stage ? ` stage=${row.stage}${stageOk ? "" : " (expected " + c.stage.join("/") + ")"}` : ""} score=${row.avgScore?.toFixed(1) ?? "-"} shown=${row.shown} ${Math.round(r.ms / 1000)}s`);
      if (r.judgeError) console.log(`      judge failed: ${r.judgeError}`);
      for (const b of bad) console.log(`      must-not: ${b}`);
      for (const s of stock) console.log(`      stock phrase: "${s}"`);
      if (flag("verbose")) texts.forEach((t) => console.log(`      - ${t}`));
    } catch (err) {
      rows.push({ id: c.id, error: err.message });
      console.log(`ERROR ${c.id}: ${err.message}`);
    }
  }
  const done = rows.filter((r) => !r.error);
  const pass = done.filter((r) => r.kindOk && r.stageOk && !r.bad.length && !r.stock.length);
  console.log(`\n${pass.length}/${rows.length} passed | read right ${pct(done.filter((r) => r.kindOk && r.stageOk).length, done.length)} | must-not hits ${done.reduce((n, r) => n + r.bad.length, 0)} | stock phrases ${done.reduce((n, r) => n + r.stock.length, 0)} | over 150 chars ${done.reduce((n, r) => n + r.overLimit, 0)} | avg judge score ${(done.reduce((n, r) => n + (r.avgScore ?? 0), 0) / Math.max(1, done.length)).toFixed(2)} | avg ${(done.reduce((n, r) => n + r.ms, 0) / Math.max(1, done.length) / 1000).toFixed(1)}s`);
  return rows;
}

// ---- replay: how close does Rizzio get to what you really sent? ----
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9']{3,}/g) ?? []);
const style = (t) => ({
  words: t.trim().split(/\s+/).length,
  lower: t === t.toLowerCase(),
  period: /\.\s*$/.test(t.trim()),
  question: t.includes("?"),
  emoji: /\p{Extended_Pictographic}/u.test(t),
  exclaim: t.includes("!"),
});

async function runReplay(file) {
  const items = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const rows = [];
  for (const it of items.slice(0, Number(opt("limit") ?? 30))) {
    try {
      const r = await reply({ mode: "chat", text: it.context });
      const real = style(it.real);
      const top = r.replies[0]?.text ?? "";
      const best = r.replies.map((x) => x.text).reduce((b, t) => {
        const w = words(t);
        const shared = [...words(it.real)].filter((x) => w.has(x)).length;
        return shared > b.shared ? { t, shared } : b;
      }, { t: top, shared: -1 });
      const s = style(top);
      const match = ["lower", "period", "question", "emoji", "exclaim"].filter((k) => s[k] === real[k]).length / 5;
      const lengthRatio = Math.min(s.words, real.words) / Math.max(s.words, real.words);
      rows.push({ real: it.real, top, closest: best.t, match, lengthRatio });
      console.log(`\nTHEIRS: ${it.context.split("\n").slice(-1)[0].slice(0, 120)}\nYOU:    ${it.real}\nRIZZIO: ${top}\n        style match ${Math.round(match * 100)}%  length ${Math.round(lengthRatio * 100)}%`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }
  const avg = (k) => rows.reduce((n, r) => n + r[k], 0) / Math.max(1, rows.length);
  console.log(`\n${rows.length} replayed | style match ${Math.round(avg("match") * 100)}% | length match ${Math.round(avg("lengthRatio") * 100)}%`);
  return rows;
}

const replay = opt("replay");
const rows = replay ? await runReplay(replay) : await runCases();
const outDir = new URL("../eval/results/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const out = new URL(`${replay ? "replay" : "cases"}-${flag("plus") ? "plus" : "premium"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, outDir);
writeFileSync(out, JSON.stringify(rows, null, 2));
console.log(`Saved ${out.pathname}`);
