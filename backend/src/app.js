import express from "express";
import { timingSafeEqual } from "node:crypto";
import { AIError } from "./ai.js";
import { PROFILE_RULES, SIGNAL_KINDS } from "./db.js";
import { randomUUID } from "node:crypto";
import { ImportError, parseExport, summarizeSenders } from "./importers.js";
import { DEFAULT_PERSONA, GOALS, SLIDERS, TOGGLES, enforcePersona, personaPhrases, renderPersona, sanitizePersona } from "./persona.js";
import { inspiration, related, renderInspiration } from "./corpus.js";
import { HINGE_CHAR_LIMIT } from "./playbook.js";
import { choose, describeTaste, emptyTaste, learn, learnRedo } from "./rank.js";
import { findOutcomes } from "./outcomes.js";
import { OPENERS, STOCK_PHRASES, renderChoices, openerUsage, overusedPhrases, phrasesIn, renderOpenerUsage, renderAutoTuneEvidence, renderMemory, renderProfileEvidence, renderReplyRequest } from "./prompts.js";

const MODES = ["auto", "prompt", "chat", "draft"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGE_B64 = 7_000_000; // ~5 MB
const USER_ID = /^[A-Za-z0-9-]{8,64}$/;
/** After this many new signals, the agent re-learns the user's voice in the background. */
export const REBUILD_EVERY = 6;

/** Example sources written by Rizzio rather than the user: good for style, never for facts about the user. */
const AI_WRITTEN = new Set(["picked", "won"]);
/** The saved line a reply was meant to be (most shared words), so it can be sent verbatim. */
function closestLine(text, lines) {
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9']+/g) ?? []);
  const t = words(text);
  let best = null;
  let bestScore = 0;
  for (const l of lines) {
    const w = words(l.text);
    const shared = [...w].filter((x) => t.has(x)).length / Math.max(1, Math.max(w.size, t.size));
    if (shared > bestScore) [best, bestScore] = [l.text, shared];
  }
  return bestScore >= 0.5 ? best : null;
}

/** Ways to reply when the model offered none (so the app can always ask). */
const DEFAULT_SIDES = [
  { label: "Keep it light", how: "Playful and easy to answer, no big moves." },
  { label: "Flirt a little", how: "A bit of charged teasing or a confident compliment about a choice they made." },
  { label: "Be direct", how: "Confident and straightforward: a clear take, or move toward a plan if it fits." },
];

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);

function parseImage(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || typeof raw.data !== "string" || raw.data.length > MAX_IMAGE_B64) {
    throw new AIError("image.data is missing or too large.", 400);
  }
  const mediaType = raw.mediaType ?? "image/jpeg";
  if (!IMAGE_TYPES.includes(mediaType)) throw new AIError("Unsupported image type.", 400);
  return { data: raw.data, mediaType };
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Max AI calls per user per hour. */
export const HOURLY_LIMIT = Number(process.env.RIZZIO_HOURLY_LIMIT) || 300; // instant side answers send one request per option

export function createApp({ store, ai, appToken, log = console, hourlyLimit = HOURLY_LIMIT, storage = { persistent: true } }) {
  const app = express();
  const usage = new Map(); // userId -> timestamps of AI calls in the last hour

  function rateLimit(req, res, next) {
    const now = Date.now();
    const recent = (usage.get(req.userId) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= hourlyLimit) {
      return res.status(429).json({ error: "You've hit the hourly limit. Try again in a bit." });
    }
    recent.push(now);
    usage.set(req.userId, recent);
    next();
  }
  app.use(express.json({ limit: "8mb" }));

  const rebuilding = new Map(); // userId -> Promise, so two rebuilds never overlap

  async function rebuildProfile(userId) {
    if (rebuilding.has(userId)) return rebuilding.get(userId);
    const job = (async () => {
      const user = store.getUser(userId);
      const evidence = renderProfileEvidence(user, store.bestExamples(userId, 60), store.recentSignals(userId, 80));
      const profile = await ai.rebuildProfile({ evidence });
      store.setVoiceProfile(userId, profile);
      return profile;
    })().finally(() => rebuilding.delete(userId));
    rebuilding.set(userId, job);
    return job;
  }

  function rebuildInBackground(userId) {
    rebuildProfile(userId).catch((err) => log.error?.(`profile rebuild failed for ${userId}:`, err.message));
  }

  /** A chat screenshot shows one of Rizzio's lines got answered: record the real result (match / replied). */
  function recordOutcomes(userId, transcript, skipGenerationId = null) {
    const found = findOutcomes(transcript, store.history(userId, 200, { includeHidden: true }).filter((g) => g.id !== skipGenerationId));
    for (const o of found) {
      store.addSignal(userId, { generationId: o.generationId, replyIndex: o.replyIndex, kind: o.kind, text: o.text });
      const gen = store.getGeneration(userId, o.generationId);
      if (gen) store.setTaste(userId, learn(store.getTaste(userId) ?? emptyTaste(), o.kind, gen.replies, o.replyIndex));
    }
    if (found.length) maybeRebuild(userId);
    return found.map(({ kind, text }) => ({ kind, text }));
  }

  function maybeRebuild(userId) {
    if (store.getUser(userId).signals_since_rebuild >= REBUILD_EVERY) rebuildInBackground(userId);
  }

  // "persistent: false" means the database isn't on a Railway Volume and is wiped on every deploy.
  app.get("/health", (_req, res) => res.json({ ok: true, persistent: storage.persistent }));

  // Everything under /v1 needs the app token and a user id (a random id the app makes on first launch).
  app.use("/v1", (req, res, next) => {
    const auth = req.get("authorization") ?? "";
    if (!appToken || !safeEqual(auth, `Bearer ${appToken}`)) return res.status(401).json({ error: "Unauthorized" });
    const userId = req.get("x-rizzio-user") ?? "";
    if (!USER_ID.test(userId)) return res.status(400).json({ error: "Missing or invalid X-Rizzio-User header." });
    store.ensureUser(userId);
    const u = store.getUser(userId);
    if (u.voice_profile?.trim() && (u.profile_rules ?? 0) < PROFILE_RULES) rebuildInBackground(userId);
    req.userId = userId;
    next();
  });

  /** Write 5 replies in the user's voice. */
  app.post("/v1/replies", rateLimit, async (req, res, next) => {
    try {
      const b = req.body ?? {};
      if (!MODES.includes(b.mode)) return res.status(400).json({ error: "mode must be auto, prompt, chat or draft." });
      const image = parseImage(b.image);
      // Recent screenshots of the same profile (the user scrolled and Back Tapped again), oldest first.
      // They also come with copied text, so a copied prompt is read knowing who the person is.
      const earlier = Array.isArray(b.earlierImages) ? b.earlierImages.slice(image ? -3 : -4).map(parseImage) : [];
      const text = str(b.text, 8000);
      const draft = str(b.draft, 2000);
      const tone = str(b.tone, 40) || "me";
      // Follow-ups from the keyboard's chat: "make it about the dog", "shorter", "use the 2nd prompt".
      const instruction = str(b.instruction, 300);
      const length = str(b.length, 20); // keyboard length meter: phrase / short / medium / long (anything else = persona)
      const stance = ["for", "against", "neutral", "both"].includes(b.stance) ? b.stance : null; // keyboard "Pick a side"
      const stanceTopic = str(b.stanceTopic, 120);
      const hook = str(b.hook, 200); // the prompt or photo the user chose to reply to
      // A side the model offered for this take ("Team 11am"), picked in the Back Tap popup or the keyboard.
      const side = b.side && typeof b.side === "object" && str(b.side.label, 60)
        ? { label: str(b.side.label, 60), how: str(b.side.how, 200) ?? "" }
        : null;
      const previous = Array.isArray(b.previous) ? b.previous.filter((t) => typeof t === "string").slice(0, 10).map((t) => t.slice(0, 300)) : [];
      if (!image && !earlier.length && !text?.trim() && !draft?.trim()) return res.status(400).json({ error: "Send an image, text, or draft." });

      const user = store.getUser(req.userId);
      // A preview (the app's Test drive) can try unsaved slider settings and isn't saved or learned from.
      const preview = b.preview === true;
      const persona = preview && b.persona ? sanitizePersona(b.persona) : sanitizePersona(store.getPersona(req.userId));
      const best = store.bestExamples(req.userId, 25, { ownWordsOnly: true });
      // How the user really uses "wait", "ngl", "lowkey"... from all of their own messages.
      const ownAll = store.listExamples(req.userId).filter((e) => !AI_WRITTEN.has(e.source)).map((e) => e.text);
      const openers = openerUsage(ownAll);
      const memory = [renderMemory(user, best), renderOpenerUsage(openers), renderPersona(persona), renderChoices(store.getChoices(req.userId))].filter(Boolean).join("\n\n");
      // Remember how the user chose to tackle this one: the side they picked, or their own typed take.
      const TAKE = "Reply the way the user wants to tackle it: ";
      const take = instruction?.startsWith(TAKE) ? instruction.slice(TAKE.length).replace(/\. All 5 messages follow this\.$/, "").trim() : null;
      // Instant side answers write every option ahead of time; only the one the user taps is their choice (POST /v1/choice).
      const speculative = b.speculative === true;
      if (!preview && !speculative && (side?.label || take)) store.recordChoice(req.userId, { side: side?.label, take });
      // The user's own messages most related to this one (beyond the 25 always shown), so wording follows how they talk about it.
      const shown = new Set(best.map((e) => e.text));
      const own = store.listExamples(req.userId).filter((e) => !AI_WRITTEN.has(e.source) && !shown.has(e.text)).map((e) => e.text);
      const ownRelated = related([text, draft].filter(Boolean).join("\n"), own, 8);
      // Catchphrases Rizzio keeps writing that the user never says ("that's a bold pick"): steer away from them.
      const overused = overusedPhrases(store.history(req.userId, 20).map((g) => g.replies.map((r) => r.text)), [...own, ...shown]);
      // The user's saved lines (their proven openers), offered word for word when one fits.
      const savedLines = store.listLines(req.userId).slice(0, 30);
      // A few relevant exchanges from the built-in library, as ideas for angle and flow (not voice).
      const refs = renderInspiration(inspiration([text, draft, instruction].filter(Boolean).join("\n"), { mode: b.mode, limit: b.mode === "draft" ? 3 : 6 }));
      const requestText = [renderReplyRequest({ mode: b.mode, tone, text, draft, hasImage: !!image || earlier.length > 0, earlier: earlier.length, current: !!image, instruction, previous, length, ownRelated, stance, stanceTopic, side, overused, hook, lines: savedLines }), refs].filter(Boolean).join("\n\n");
      // Premium Plus (the app sends X-Rizzio-Tier: plus) is written by the stronger model.
      const plus = req.get("x-rizzio-tier") === "plus";
      const t0 = Date.now();
      // Previews (the eval script) can try another thinking depth, to measure speed against quality.
      // Profile comments read well with light thinking (fast); chats need more (when to ask, answering questions).
      // Back Tap sends mode auto, so the phone hints what it saw (bubbles on both sides = chat).
      const looksLikeProfile = b.mode === "prompt" || (b.mode === "auto" && b.looksLike === "profile");
      const effort = preview && ["low", "medium", "high"].includes(b.effort) ? b.effort : looksLikeProfile ? "low" : "medium";
      const raw = await ai.generateReplies({ memory, requestText, image, earlier, plus, effort });
      const timings = { generateMs: Date.now() - t0 };
      // Ways to reply offered without a take to agree or disagree with (a boundary, what they want from the user):
      // give them a topic anyway, so the app still asks which way to go.
      // The user is asked how to reply after every screenshot: make sure there are options and a topic.
      raw.read ??= {};
      if (!raw.read.sides?.length) raw.read.sides = DEFAULT_SIDES;
      if (raw.read?.sides?.length && !raw.read.side_topic?.trim()) raw.read.side_topic = "how to reply";
      // Two truths and a lie: one fixed topic, so the app knows to ask "Which one's the lie?".
      if (raw.read?.sides?.some((s) => /^lie:/i.test(s.label))) raw.read.side_topic = "which is the lie";
      const ownText = [...own, ...shown].join("\n");
      const banned = [...STOCK_PHRASES, ...personaPhrases(persona), ...overused, ...openers.never].filter((p) => phrasesIn(ownText, [p]).length === 0);
      // Write many, show the best: a judge scores every candidate (misread, generic, invented facts, not the user),
      // stock phrases cost points, and the user's learned taste nudges the order. Weak ones are dropped.
      let scores = null;
      let judgeError = null;
      if (ai.judgeReplies && raw.replies.length >= 3) {
        try {
          const tj = Date.now();
          scores = await ai.judgeReplies({ memory, requestText, read: raw.read, texts: raw.replies.map((r) => r.text), image, plus });
          timings.judgeMs = Date.now() - tj;
        } catch (err) {
          judgeError = err.message;
          log.error?.(`judging replies failed: ${err.message}`); // fall back to the model's own order
        }
      }
      const candidates = raw.replies;
      const candidateFlags = candidates.map((r) => phrasesIn(r.text, banned));
      const taste = store.getTaste(req.userId);
      const wantJoke = Boolean(raw.read?.her_humor?.trim());
      raw.replies = choose(candidates, { scores, flags: candidateFlags, taste, wantJoke });
      // Instant side answers at no extra cost: the candidates already cover every option, tagged with it.
      // For each option with 3+ clean ones, the judge's best are kept as their own set, ready for when the user taps it.
      const bySide = {};
      // Any instruction (a redo, "shorter", a typed take) shapes every candidate, so the per-side sets still fit it.
      if (scores && !side?.label && !stance) {
        for (const o of raw.read?.sides ?? []) {
          const isProfile = b.mode === "prompt" || String(raw.read?.kind ?? "").startsWith("profile");
          const idx = candidates
            .map((_, i) => i)
            .filter((i) => candidates[i].option === o.label && !candidateFlags[i].length && (!isProfile || candidates[i].text.length <= HINGE_CHAR_LIMIT));
          if (idx.length < 3) continue;
          const replies = enforcePersona(persona, choose(idx.map((i) => candidates[i]), { scores: idx.map((i) => scores[i]), taste, wantJoke }));
          bySide[o.label] = { generationId: preview ? null : store.saveGeneration(req.userId, { mode: b.mode, tone, context: raw.context, replies }, { hidden: true }), replies };
        }
      }
      // Safety net: a shown reply that still uses a stock or overused phrase the user never says is rewritten once.
      const flagged = raw.replies.map((r) => phrasesIn(r.text, banned));
      // An opener ("lol", "wait", "ok but"...) in more than 2 of the 5 reads like a tic: drop it from the extra ones.
      for (const o of OPENERS) {
        const withIt = raw.replies.map((r, i) => (phrasesIn(r.text, [o]).length ? i : -1)).filter((i) => i >= 0);
        for (const i of withIt.slice(2)) flagged[i].push(o);
      }
      const bad = flagged.map((found, i) => [i, [...new Set(found)]]).filter(([, found]) => found.length);
      if (bad.length && ai.rewriteWithout) {
        try {
          const fixed = await ai.rewriteWithout({ plus, memory, texts: bad.map(([i]) => raw.replies[i].text), phrases: [...new Set(bad.flatMap(([, f]) => f))] });
          bad.forEach(([i], k) => { if (typeof fixed[k] === "string" && fixed[k].trim()) raw.replies[i] = { ...raw.replies[i], text: fixed[k].trim() }; });
        } catch (err) {
          log.error?.(`rewrite without stock phrases failed: ${err.message}`); // keep the originals
        }
      }
      // Hinge comments are capped at 150 characters: shorten any profile comment that's over.
      const profileComment = b.mode === "prompt" || String(raw.read?.kind ?? "").startsWith("profile");
      const tooLong = profileComment ? raw.replies.map((r, i) => [i, r.text]).filter(([, t]) => t.length > HINGE_CHAR_LIMIT) : [];
      if (tooLong.length && ai.rewriteTexts) {
        try {
          const short = await ai.rewriteTexts({
            plus,
            memory,
            texts: tooLong.map(([, t]) => t),
            instruction: `Shorten each of these Hinge comments to under ${HINGE_CHAR_LIMIT} characters, keeping the idea, the voice and the question if there is one.`,
          });
          tooLong.forEach(([i], k) => { if (typeof short[k] === "string" && short[k].trim()) raw.replies[i] = { ...raw.replies[i], text: short[k].trim() }; });
        } catch (err) {
          log.error?.(`shortening long comments failed: ${err.message}`);
        }
      }
      // A saved line goes out exactly as the user saved it, even if the model changed a word.
      raw.replies = raw.replies.map((r) => (r.form === "saved_line" ? { ...r, text: closestLine(r.text, savedLines) ?? r.text } : r));
      // Persona clean-ups (lowercase, no emoji...) don't touch a saved line: it's already the user's own wording.
      const result = { ...raw, replies: enforcePersona(persona, raw.replies).map((r, i) => (raw.replies[i].form === "saved_line" ? { ...r, text: raw.replies[i].text } : r)) };
      const generationId = preview ? null : store.saveGeneration(req.userId, { mode: b.mode, tone, ...result });
      // A chat screenshot: if it shows one of Rizzio's earlier lines got an answer, learn from that real result.
      const outcomes = !preview && !speculative && result.read?.transcript?.length ? recordOutcomes(req.userId, result.read.transcript, generationId) : [];
      if (result.read) delete result.read.transcript;
      // Previews (Test drive, the eval script) also say if the judge failed, to make that visible.
      timings.totalMs = Date.now() - t0;
      res.json({ generationId, ...result, ...(Object.keys(bySide).length ? { bySide } : {}), ...(outcomes.length ? { outcomes } : {}), ...(preview ? { timings, ...(judgeError ? { judgeError } : {}) } : {}) });
    } catch (err) {
      next(err);
    }
  });

  // ---- Free mode (Apple Intelligence on the phone): store results, no AI calls here ----

  /** Relevant exchanges from the built-in library, for the on-phone model's prompt. No AI. */
  app.post("/v1/inspiration", (req, res) => {
    const b = req.body ?? {};
    const mode = MODES.includes(b.mode) ? b.mode : "auto";
    const limit = Math.min(Math.max(Number(b.limit) || 4, 1), 10);
    const text = str(b.text, 4000) ?? "";
    const own = store.listExamples(req.userId).filter((e) => !AI_WRITTEN.has(e.source)).map((e) => e.text);
    res.json({ items: inspiration(text, { mode, limit }), own: related(text, own, 6) });
  });

  const cleanReplies = (raw) =>
    Array.isArray(raw)
      ? raw
          .filter((r) => r && typeof r.text === "string")
          .slice(0, 5)
          .map((r) => ({ text: r.text.slice(0, 500), angle: typeof r.angle === "string" ? r.angle.slice(0, 60) : "" }))
      : [];

  /** Saves replies written on the phone so History and learning work the same as Premium. */
  app.post("/v1/generations", (req, res) => {
    const b = req.body ?? {};
    const replies = cleanReplies(b.replies);
    if (!MODES.includes(b.mode) || replies.length === 0) return res.status(400).json({ error: "Send mode and replies." });
    const generationId = store.saveGeneration(req.userId, {
      mode: b.mode,
      tone: str(b.tone, 40) || "me",
      context: str(b.context, 300) || "",
      replies,
    });
    res.json({ generationId });
  });

  /** Adds messages the phone read from your chat screenshots. */
  app.post("/v1/me/examples", (req, res) => {
    const texts = Array.isArray(req.body?.texts)
      ? req.body.texts.filter((t) => typeof t === "string" && t.trim()).map((t) => t.slice(0, 500)).slice(0, 60)
      : [];
    for (const t of texts) store.addExample(req.userId, t, "imported");
    res.json({ added: texts.length });
  });

  /** Saves a texting-style summary the phone wrote itself. */
  app.put("/v1/me/profile", (req, res) => {
    const profile = str(req.body?.voiceProfile, 4000);
    if (!profile?.trim()) return res.status(400).json({ error: "Send voiceProfile." });
    store.setVoiceProfile(req.userId, profile.trim());
    res.json({ voiceProfile: profile.trim() });
  });

  /** Tell the agent what happened: picked, edited, rejected, match, replied, ignored. */
  app.post("/v1/feedback", (req, res) => {
    const b = req.body ?? {};
    if (!SIGNAL_KINDS.includes(b.kind)) return res.status(400).json({ error: `kind must be one of ${SIGNAL_KINDS.join(", ")}.` });
    const generationId = str(b.generationId, 64) ?? null;
    if (generationId && !store.getGeneration(req.userId, generationId)) return res.status(404).json({ error: "Unknown generationId." });
    const replyIndex = Number.isInteger(b.replyIndex) && b.replyIndex >= 0 && b.replyIndex < 10 ? b.replyIndex : null;
    const text = str(b.text, 2000)?.trim() || null;
    if (b.kind === "edited" && !text) return res.status(400).json({ error: "edited needs the text you sent." });

    store.addSignal(req.userId, { generationId, replyIndex, kind: b.kind, text });
    // Teach the ranking model what this user goes for.
    const gen = generationId ? store.getGeneration(req.userId, generationId) : null;
    if (gen && b.kind === "redo") store.setTaste(req.userId, learnRedo(store.getTaste(req.userId) ?? emptyTaste(), gen.replies));
    else if (gen && replyIndex != null) store.setTaste(req.userId, learn(store.getTaste(req.userId) ?? emptyTaste(), b.kind, gen.replies, replyIndex));
    maybeRebuild(req.userId);
    res.json({ ok: true });
  });

  /** What Rizzio knows about you. */
  app.get("/v1/me", (req, res) => {
    const user = store.getUser(req.userId);
    res.json({
      aboutMe: user.about_me,
      taste: describeTaste(store.getTaste(req.userId)),
      choices: store.getChoices(req.userId),
      styleExamples: store.listExamples(req.userId, "seed").map((e) => e.text),
      voiceProfile: user.voice_profile,
      profileUpdatedAt: user.profile_updated_at,
      learnedExamples: store
        .listExamples(req.userId)
        .filter((e) => e.source !== "seed")
        .slice(0, 30) // a sample; the full list is paged via /v1/me/examples
        .map((e) => ({ id: e.id, text: e.text, source: e.source })),
      stats: store.stats(req.userId),
    });
  });

  /** Drafts About you from the user's own messages and profile. Returns the text; nothing is saved. */
  app.post("/v1/me/about/suggest", rateLimit, async (req, res, next) => {
    try {
      const user = store.getUser(req.userId);
      const own = store.listExamples(req.userId).filter((e) => !AI_WRITTEN.has(e.source)).slice(0, 150);
      if (!own.length && !user.voice_profile?.trim()) {
        return res.status(409).json({ error: "Upload some of your chats in Train first, so Rizzio has something to go on." });
      }
      const evidence = [
        `## Current note\n${user.about_me?.trim() || "(empty)"}`,
        `## Voice profile\n${user.voice_profile?.trim() || "(not learned yet)"}`,
        `## Messages the user sent\n${own.map((e) => `- ${e.text}`).join("\n") || "(none)"}`,
      ].join("\n\n");
      res.json({ about: await ai.suggestAbout({ evidence }) });
    } catch (err) {
      next(err);
    }
  });

  /** Update about-me and hand-written examples, then re-learn. */
  app.put("/v1/me", (req, res) => {
    const b = req.body ?? {};
    if (typeof b.aboutMe === "string") store.updateAboutMe(req.userId, b.aboutMe.slice(0, 2000));
    if (Array.isArray(b.styleExamples)) {
      const texts = b.styleExamples.filter((t) => typeof t === "string").map((t) => t.slice(0, 500)).slice(0, 40);
      store.setSeedExamples(req.userId, texts);
    }
    rebuildInBackground(req.userId);
    res.json({ ok: true });
  });

  // ---- Import exported chats (WhatsApp, Instagram, Telegram, Hinge, Tinder, CSV/JSON/TXT, zips) ----
  // Step 1 parses the file and asks "which one is you?"; step 2 saves only that person's messages.
  const pendingImports = new Map(); // importId -> { userId, senders, expires }
  const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
  const MAX_IMPORT_MESSAGES = 1500;

  app.post(
    "/v1/learn/file/preview",
    express.raw({ type: () => true, limit: MAX_IMPORT_BYTES }),
    async (req, res) => {
      const name = str(req.query.name, 200) || "upload.txt";
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "Send the file contents." });
      let parsed;
      try {
        parsed = await parseExport(name, new Uint8Array(req.body));
      } catch (err) {
        if (err instanceof ImportError) return res.status(err.kind === "image" ? 415 : 400).json({ error: err.message, kind: err.kind });
        return res.status(400).json({ error: err.message });
      }
      const { senders, guess } = summarizeSenders(parsed.messages);
      if (senders.length === 0) {
        return res.status(422).json({ error: "Couldn't find any messages in that file. Try a WhatsApp .txt, Instagram/Telegram JSON, or a .csv." });
      }
      for (const [id, p] of pendingImports) if (p.expires < Date.now()) pendingImports.delete(id);
      const importId = randomUUID();
      pendingImports.set(importId, { userId: req.userId, senders, expires: Date.now() + 30 * 60_000 });
      res.json({
        importId,
        format: parsed.format,
        total: senders.reduce((n, s) => n + s.count, 0),
        guess,
        senders: senders.slice(0, 20).map((s) => ({ name: s.name, count: s.count, samples: s.texts.slice(-3) })),
      });
    },
  );

  app.post("/v1/learn/file/commit", (req, res) => {
    const pending = pendingImports.get(str(req.body?.importId, 64) ?? "");
    if (!pending || pending.userId !== req.userId || pending.expires < Date.now()) {
      return res.status(404).json({ error: "That import expired. Pick the file again." });
    }
    const sender = pending.senders.find((s) => s.name === req.body?.sender);
    if (!sender) return res.status(400).json({ error: "Pick which person is you." });
    const texts = sender.texts.slice(-MAX_IMPORT_MESSAGES); // most recent messages are the best picture of how you text now
    const added = store.addExamplesBulk(req.userId, texts, "imported");
    pendingImports.delete(req.body.importId);
    res.json({ added, considered: texts.length });
  });

  /** Everything Rizzio learned from you, a page at a time (the app doesn't load it all at once). */
  app.get("/v1/me/examples", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(store.examplesPage(req.userId, { limit, offset, q: str(req.query.q, 100) ?? "" }));
  });

  /** Teach Rizzio from a screenshot of one of your own chats. */
  app.post("/v1/learn/screenshot", rateLimit, async (req, res, next) => {
    try {
      const image = parseImage(req.body?.image);
      if (!image) return res.status(400).json({ error: "Send an image." });
      const messages = await ai.extractUserMessages({ image });
      for (const m of messages) store.addExample(req.userId, m, "imported");
      if (messages.length) rebuildInBackground(req.userId);
      res.json({ learned: messages });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/v1/me/examples/:id", (req, res) => {
    store.deleteExample(req.userId, Number(req.params.id));
    res.json({ ok: true });
  });

  /** The persona sliders, plus the slider definitions so the app and server agree. */
  app.get("/v1/me/persona", (req, res) => {
    res.json({
      persona: sanitizePersona(store.getPersona(req.userId)),
      defaults: DEFAULT_PERSONA,
      sliders: SLIDERS,
      toggles: TOGGLES.map((t) => t.key),
      goals: Object.keys(GOALS),
    });
  });

  app.put("/v1/me/persona", (req, res) => {
    const persona = sanitizePersona(req.body?.persona ?? req.body);
    store.setPersona(req.userId, persona);
    res.json({ persona });
  });

  /** Suggests slider values from how the user actually texts. Doesn't save; the app shows them first. */
  app.post("/v1/me/persona/autotune", rateLimit, async (req, res, next) => {
    try {
      const user = store.getUser(req.userId);
      const examples = store.bestExamples(req.userId, 60);
      if (!user.voice_profile?.trim() && examples.length === 0) {
        return res.status(409).json({ error: "Upload some of your chats first so Rizzio knows how you text." });
      }
      const evidence = renderAutoTuneEvidence(user, examples, SLIDERS);
      res.json(await ai.autoTune({ evidence }));
    } catch (err) {
      next(err);
    }
  });

  /** Re-learn now and return the new profile. */
  app.post("/v1/me/rebuild", rateLimit, async (req, res, next) => {
    try {
      res.json({ voiceProfile: await rebuildProfile(req.userId) });
    } catch (err) {
      next(err);
    }
  });

  /** Forget everything learned (keeps your about-me and hand-written examples). */
  /** The side the user tapped when the options were written ahead of time (instant side answers). */
  app.post("/v1/choice", (req, res) => {
    const side = str(req.body?.side, 60)?.trim();
    if (side) store.recordChoice(req.userId, { side });
    const generationId = str(req.body?.generationId, 64);
    if (generationId) store.unhideGeneration(req.userId, generationId);
    res.json({ ok: true });
  });

  /** Free mode: the phone read a chat screenshot itself; check it for results of Rizzio's earlier lines. */
  app.post("/v1/outcomes", (req, res) => {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines.slice(0, 80).map((l) => ({ from: l?.from, text: str(l?.text, 500) })) : [];
    res.json({ outcomes: recordOutcomes(req.userId, lines) });
  });

  /** "Your best lines": openers the user knows work. */
  app.get("/v1/me/lines", (req, res) => res.json({ lines: store.listLines(req.userId) }));

  app.post("/v1/me/lines", (req, res) => {
    const text = str(req.body?.text, 300)?.trim();
    if (!text) return res.status(400).json({ error: "Send the line's text." });
    if (store.listLines(req.userId).length >= 100) return res.status(400).json({ error: "You can save up to 100 lines." });
    res.json({ line: store.addLine(req.userId, text, str(req.body?.useWhen, 200)?.trim() ?? "") });
  });

  app.delete("/v1/me/lines/:id", (req, res) => {
    store.deleteLine(req.userId, Number(req.params.id));
    res.json({ ok: true });
  });

  /** Forget the ranking model only (what the user tends to pick). */
  app.delete("/v1/me/taste", (req, res) => {
    store.setTaste(req.userId, null);
    res.json({ ok: true });
  });

  app.delete("/v1/me/memory", (req, res) => {
    store.resetLearning(req.userId);
    res.json({ ok: true });
  });

  app.get("/v1/history", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    res.json({ items: store.history(req.userId, limit) });
  });

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof AIError) return res.status(err.status).json({ error: err.message });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "Upload too large." });
    log.error?.(err);
    res.status(500).json({ error: "Unexpected server error." });
  });

  return app;
}
