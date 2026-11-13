import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Rizzio's memory. Everything the agent learns about a user lives here:
 *  - users:       settings + the distilled "voice profile" the agent writes about the user
 *  - generations: every set of 5 replies it wrote
 *  - signals:     what the user did with them (picked, edited, sent, rejected, got a match...)
 *  - examples:    messages in the user's own words (typed by them, edited by them, imported)
 */
export function openDb(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      about_me TEXT NOT NULL DEFAULT '',
      voice_profile TEXT NOT NULL DEFAULT '',
      profile_updated_at TEXT,
      signals_since_rebuild INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      tone TEXT NOT NULL,
      context TEXT NOT NULL,
      replies_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS generations_user ON generations(user_id, created_at);
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      generation_id TEXT,
      reply_index INTEGER,
      kind TEXT NOT NULL,
      text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS signals_user ON signals(user_id, created_at);
    CREATE TABLE IF NOT EXISTS examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, text)
    );
  `);
  // Added after the first release: add the column to databases created before it.
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes("persona_json")) db.exec("ALTER TABLE users ADD COLUMN persona_json TEXT");
  if (!cols.includes("profile_rules")) db.exec("ALTER TABLE users ADD COLUMN profile_rules INTEGER NOT NULL DEFAULT 0");
  return new Store(db);
}

/** Version of the voice-profile rules. Profiles built under older rules are rebuilt once. 1: facts only from the user's own words. */
export const PROFILE_RULES = 1;
export const SIGNAL_KINDS = ["picked", "edited", "rejected", "match", "replied", "ignored"];

/** How strongly each source shows the user's real voice (higher = stronger). */
const SOURCE_RANK = { won: 5, edited: 4, seed: 3, imported: 3, picked: 1 };

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  ensureUser(id) {
    this.db.prepare("INSERT OR IGNORE INTO users (id) VALUES (?)").run(id);
    return this.getUser(id);
  }

  getUser(id) {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }

  updateAboutMe(id, aboutMe) {
    this.db.prepare("UPDATE users SET about_me = ? WHERE id = ?").run(aboutMe, id);
  }

  getPersona(id) {
    const row = this.db.prepare("SELECT persona_json FROM users WHERE id = ?").get(id);
    return row?.persona_json ? JSON.parse(row.persona_json) : null;
  }

  setPersona(id, persona) {
    this.db.prepare("UPDATE users SET persona_json = ? WHERE id = ?").run(JSON.stringify(persona), id);
  }

  setVoiceProfile(id, profile) {
    this.db
      .prepare("UPDATE users SET voice_profile = ?, profile_updated_at = datetime('now'), signals_since_rebuild = 0, profile_rules = ? WHERE id = ?")
      .run(profile, PROFILE_RULES, id);
  }

  /** Replaces the user's hand-written seed examples. */
  setSeedExamples(userId, texts) {
    this.db.prepare("DELETE FROM examples WHERE user_id = ? AND source = 'seed'").run(userId);
    for (const t of texts) this.addExample(userId, t, "seed");
  }

  addExample(userId, text, source, context = null) {
    const clean = text.trim();
    if (!clean) return;
    const existing = this.db.prepare("SELECT source FROM examples WHERE user_id = ? AND text = ?").get(userId, clean);
    if (!existing) {
      this.db.prepare("INSERT INTO examples (user_id, text, source, context) VALUES (?, ?, ?, ?)").run(userId, clean, source, context);
    } else if ((SOURCE_RANK[source] ?? 0) > (SOURCE_RANK[existing.source] ?? 0)) {
      // Same message, stronger evidence (e.g. a picked reply later got a match): upgrade it.
      this.db.prepare("UPDATE examples SET source = ?, created_at = datetime('now') WHERE user_id = ? AND text = ?").run(source, userId, clean);
    }
  }

  /** Adds many messages at once (one transaction, so big imports stay fast). Returns how many were new. */
  addExamplesBulk(userId, texts, source) {
    const before = this.db.prepare("SELECT COUNT(*) AS n FROM examples WHERE user_id = ?").get(userId).n;
    this.db.exec("BEGIN");
    try {
      for (const t of texts) this.addExample(userId, t, source);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.db.prepare("SELECT COUNT(*) AS n FROM examples WHERE user_id = ?").get(userId).n - before;
  }

  /** One page of what Rizzio learned, newest first, optionally filtered by text. */
  examplesPage(userId, { limit = 50, offset = 0, q = "" } = {}) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const where = "user_id = ? AND source != 'seed' AND text LIKE ?";
    const items = this.db
      .prepare(`SELECT id, text, source FROM examples WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(userId, like, limit, offset);
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM examples WHERE ${where}`).get(userId, like).n;
    return { items, total };
  }

  listExamples(userId, source = null) {
    if (source) {
      return this.db.prepare("SELECT * FROM examples WHERE user_id = ? AND source = ? ORDER BY id").all(userId, source);
    }
    return this.db.prepare("SELECT * FROM examples WHERE user_id = ? ORDER BY id DESC").all(userId);
  }

  deleteExample(userId, id) {
    this.db.prepare("DELETE FROM examples WHERE user_id = ? AND id = ?").run(userId, id);
  }

  /**
   * The examples that best show the user's voice, strongest evidence first.
   * ownWordsOnly skips "picked" replies: those were written by the AI, so feeding them back
   * as "the user's voice" would slowly make Rizzio sound like itself instead of the user.
   */
  bestExamples(userId, limit = 25, { ownWordsOnly = false } = {}) {
    const rows = this.db
      .prepare("SELECT * FROM examples WHERE user_id = ?")
      .all(userId)
      .filter((e) => !ownWordsOnly || e.source !== "picked");
    return rows
      .sort((a, b) => (SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0) || b.id - a.id)
      .slice(0, limit);
  }

  saveGeneration(userId, { mode, tone, context, replies }) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO generations (id, user_id, mode, tone, context, replies_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, mode, tone, context, JSON.stringify(replies));
    return id;
  }

  getGeneration(userId, id) {
    const row = this.db.prepare("SELECT * FROM generations WHERE user_id = ? AND id = ?").get(userId, id);
    return row ? { ...row, replies: JSON.parse(row.replies_json) } : null;
  }

  history(userId, limit = 30) {
    const gens = this.db
      .prepare("SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(userId, limit);
    const sigStmt = this.db.prepare("SELECT kind, reply_index, text, created_at FROM signals WHERE generation_id = ? ORDER BY id");
    return gens.map((g) => ({
      id: g.id,
      mode: g.mode,
      tone: g.tone,
      context: g.context,
      replies: JSON.parse(g.replies_json),
      createdAt: g.created_at,
      signals: sigStmt.all(g.id).map((s) => ({ kind: s.kind, replyIndex: s.reply_index, text: s.text, createdAt: s.created_at })),
    }));
  }

  /**
   * Records what the user did with a reply, and turns it into memory:
   *  picked  → the reply suits them           (weak example)
   *  edited  → their own rewrite of it         (strong example: their real voice)
   *  match / replied → it worked               (strongest example)
   *  rejected / ignored → what to avoid        (only used when rebuilding the profile)
   */
  addSignal(userId, { generationId = null, replyIndex = null, kind, text = null }) {
    this.db
      .prepare("INSERT INTO signals (user_id, generation_id, reply_index, kind, text) VALUES (?, ?, ?, ?, ?)")
      .run(userId, generationId, replyIndex, kind, text);
    this.db.prepare("UPDATE users SET signals_since_rebuild = signals_since_rebuild + 1 WHERE id = ?").run(userId);

    const gen = generationId ? this.getGeneration(userId, generationId) : null;
    const replyText = gen && replyIndex != null ? gen.replies[replyIndex]?.text : null;
    const context = gen?.context ?? null;
    if (kind === "edited" && text) this.addExample(userId, text, "edited", context);
    if (kind === "picked" && replyText) this.addExample(userId, replyText, "picked", context);
    if ((kind === "match" || kind === "replied") && (text || replyText)) {
      this.addExample(userId, text || this.lastSentText(userId, generationId) || replyText, "won", context);
    }
  }

  /** The user's final version of a reply (their edit if they made one). */
  lastSentText(userId, generationId) {
    const row = this.db
      .prepare("SELECT text FROM signals WHERE user_id = ? AND generation_id = ? AND kind = 'edited' ORDER BY id DESC LIMIT 1")
      .get(userId, generationId);
    return row?.text ?? null;
  }

  /** Recent signals with the reply text attached, for profile rebuilding. */
  recentSignals(userId, limit = 80) {
    const rows = this.db
      .prepare(`SELECT s.kind, s.text, s.reply_index, g.replies_json, g.context, g.mode
                FROM signals s LEFT JOIN generations g ON g.id = s.generation_id
                WHERE s.user_id = ? ORDER BY s.id DESC LIMIT ?`)
      .all(userId, limit);
    return rows.map((r) => {
      const replies = r.replies_json ? JSON.parse(r.replies_json) : [];
      return {
        kind: r.kind,
        context: r.context,
        mode: r.mode,
        reply: r.reply_index != null ? replies[r.reply_index]?.text ?? null : null,
        text: r.text,
      };
    });
  }

  stats(userId) {
    const count = (sql) => this.db.prepare(sql).get(userId).n;
    return {
      generations: count("SELECT COUNT(*) AS n FROM generations WHERE user_id = ?"),
      examples: count("SELECT COUNT(*) AS n FROM examples WHERE user_id = ?"),
      wins: count("SELECT COUNT(*) AS n FROM signals WHERE user_id = ? AND kind IN ('match','replied')"),
      picks: count("SELECT COUNT(*) AS n FROM signals WHERE user_id = ? AND kind = 'picked'"),
    };
  }

  /** Forget everything learned (keeps about-me and the hand-written examples). */
  resetLearning(userId) {
    this.db.prepare("DELETE FROM signals WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM examples WHERE user_id = ? AND source != 'seed'").run(userId);
    this.db.prepare("DELETE FROM generations WHERE user_id = ?").run(userId);
    this.db.prepare("UPDATE users SET voice_profile = '', profile_updated_at = NULL, signals_since_rebuild = 0 WHERE id = ?").run(userId);
  }
}
