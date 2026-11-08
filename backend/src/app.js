import express from "express";
import { timingSafeEqual } from "node:crypto";
import { AIError } from "./ai.js";
import { SIGNAL_KINDS } from "./db.js";
import { randomUUID } from "node:crypto";
import { ImportError, parseExport, summarizeSenders } from "./importers.js";
import { DEFAULT_PERSONA, GOALS, SLIDERS, TOGGLES, renderPersona, sanitizePersona } from "./persona.js";
import { renderAutoTuneEvidence, renderMemory, renderProfileEvidence, renderReplyRequest } from "./prompts.js";

const MODES = ["auto", "prompt", "chat", "draft"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGE_B64 = 7_000_000; // ~5 MB
const USER_ID = /^[A-Za-z0-9-]{8,64}$/;
/** After this many new signals, the agent re-learns the user's voice in the background. */
export const REBUILD_EVERY = 6;

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
export const HOURLY_LIMIT = Number(process.env.RIZZIO_HOURLY_LIMIT) || 120;

export function createApp({ store, ai, appToken, log = console, hourlyLimit = HOURLY_LIMIT }) {
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

  function maybeRebuild(userId) {
    if (store.getUser(userId).signals_since_rebuild >= REBUILD_EVERY) rebuildInBackground(userId);
  }

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Everything under /v1 needs the app token and a user id (a random id the app makes on first launch).
  app.use("/v1", (req, res, next) => {
    const auth = req.get("authorization") ?? "";
    if (!appToken || !safeEqual(auth, `Bearer ${appToken}`)) return res.status(401).json({ error: "Unauthorized" });
    const userId = req.get("x-rizzio-user") ?? "";
    if (!USER_ID.test(userId)) return res.status(400).json({ error: "Missing or invalid X-Rizzio-User header." });
    store.ensureUser(userId);
    req.userId = userId;
    next();
  });

  /** Write 5 replies in the user's voice. */
  app.post("/v1/replies", rateLimit, async (req, res, next) => {
    try {
      const b = req.body ?? {};
      if (!MODES.includes(b.mode)) return res.status(400).json({ error: "mode must be auto, prompt, chat or draft." });
      const image = parseImage(b.image);
      const text = str(b.text, 8000);
      const draft = str(b.draft, 2000);
      const tone = str(b.tone, 40) || "me";
      if (!image && !text?.trim() && !draft?.trim()) return res.status(400).json({ error: "Send an image, text, or draft." });

      const user = store.getUser(req.userId);
      // A preview (the app's Test drive) can try unsaved slider settings and isn't saved or learned from.
      const preview = b.preview === true;
      const persona = preview && b.persona ? sanitizePersona(b.persona) : sanitizePersona(store.getPersona(req.userId));
      const memory = renderMemory(user, store.bestExamples(req.userId, 25, { ownWordsOnly: true })) + "\n\n" + renderPersona(persona);
      const requestText = renderReplyRequest({ mode: b.mode, tone, text, draft, hasImage: !!image });
      const result = await ai.generateReplies({ memory, requestText, image });
      const generationId = preview ? null : store.saveGeneration(req.userId, { mode: b.mode, tone, ...result });
      res.json({ generationId, ...result });
    } catch (err) {
      next(err);
    }
  });

  // ---- Free mode (Apple Intelligence on the phone): store results, no AI calls here ----

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
    maybeRebuild(req.userId);
    res.json({ ok: true });
  });

  /** What Rizzio knows about you. */
  app.get("/v1/me", (req, res) => {
    const user = store.getUser(req.userId);
    res.json({
      aboutMe: user.about_me,
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
