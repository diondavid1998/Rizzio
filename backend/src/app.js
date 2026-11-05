import express from "express";
import { timingSafeEqual } from "node:crypto";
import { AIError } from "./ai.js";
import { SIGNAL_KINDS } from "./db.js";
import { renderMemory, renderProfileEvidence, renderReplyRequest } from "./prompts.js";

const MODES = ["prompt", "chat", "draft"];
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

export function createApp({ store, ai, appToken, log = console }) {
  const app = express();
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
  app.post("/v1/replies", async (req, res, next) => {
    try {
      const b = req.body ?? {};
      if (!MODES.includes(b.mode)) return res.status(400).json({ error: "mode must be prompt, chat or draft." });
      const image = parseImage(b.image);
      const text = str(b.text, 8000);
      const draft = str(b.draft, 2000);
      const tone = str(b.tone, 40) || "witty";
      if (!image && !text?.trim() && !draft?.trim()) return res.status(400).json({ error: "Send an image, text, or draft." });

      const user = store.getUser(req.userId);
      const memory = renderMemory(user, store.bestExamples(req.userId, 25));
      const requestText = renderReplyRequest({ mode: b.mode, tone, text, draft, hasImage: !!image });
      const result = await ai.generateReplies({ memory, requestText, image });
      const generationId = store.saveGeneration(req.userId, { mode: b.mode, tone, ...result });
      res.json({ generationId, ...result });
    } catch (err) {
      next(err);
    }
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
        .slice(0, 50)
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

  /** Teach Rizzio from a screenshot of one of your own chats. */
  app.post("/v1/learn/screenshot", async (req, res, next) => {
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

  /** Re-learn now and return the new profile. */
  app.post("/v1/me/rebuild", async (req, res, next) => {
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
