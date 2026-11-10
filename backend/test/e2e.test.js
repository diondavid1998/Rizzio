// Walks the whole app flow against the real HTTP server, in the order a new user does it:
// health → test drive → upload chats → paste messages → auto-tune → save persona →
// Action Button reply → keyboard picks/edits → history outcome → what Rizzio knows.
// Claude is faked (no API key in CI), but every request and response shape is the real one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";

class RealisticFakeAI {
  async generateReplies({ memory, requestText }) {
    return {
      context: requestText.includes("first work out") ? "Profile prompt: Typical Sunday" : "Chat",
      replies: Array.from({ length: 5 }, (_, i) => ({
        text: memory.includes("Write in all lowercase") ? `reply ${i} lol` : `Reply ${i}`,
        angle: "playful tease",
      })),
    };
  }
  async rebuildProfile({ evidence }) {
    return evidence.includes("OWN WORDS") ? "Voice: short, lowercase, dry." : "Voice: (not much yet)";
  }
  async autoTune() {
    return { settings: [{ key: "emoji", value: 0, reason: "never uses emoji" }, { key: "length", value: 15, reason: "short texts" }], lowercase: true };
  }
  async extractUserMessages() {
    return ["lmao no", "ok but tacos tho", "say less"];
  }
}

test("full app flow, start to finish", async () => {
  const store = openDb(":memory:");
  const app = createApp({ store, ai: new RealisticFakeAI(), appToken: "tok", log: { error() {} } });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: "Bearer tok", "x-rizzio-user": "6F1C2D3E-AAAA-BBBB-CCCC-123456789ABC", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const img = { data: Buffer.from("fake-jpeg").toString("base64"), mediaType: "image/jpeg" };

  try {
    // Setup tab: server reachable.
    assert.deepEqual(await (await fetch(base + "/health")).json(), { ok: true, persistent: true });

    // Persona tab loads defaults; Test drive works with unsaved sliders and saves nothing.
    const persona = (await call("GET", "/v1/me/persona")).body.persona;
    assert.equal(persona.goal, "match");
    const drive = await call("POST", "/v1/replies", { mode: "prompt", tone: "me", text: "Prompt: Typical Sunday", preview: true, persona });
    assert.equal(drive.status, 200);
    assert.equal(drive.body.replies.length, 5);
    assert.equal(drive.body.generationId, null);

    // Auto-tune before any texts: clear message instead of nothing.
    const early = await call("POST", "/v1/me/persona/autotune");
    assert.equal(early.status, 409);
    assert.match(early.body.error, /Upload some of your chats/);

    // Train: upload a chat screenshot → its messages are learned.
    const learned = await call("POST", "/v1/learn/screenshot", { image: img });
    assert.deepEqual(learned.body.learned, ["lmao no", "ok but tacos tho", "say less"]);

    // Train: paste messages (PUT keeps About you), then re-learn → profile written.
    assert.equal((await call("PUT", "/v1/me", { aboutMe: "27, nyc", styleExamples: ["bet", "nah ur wild"] })).status, 200);
    const rebuilt = await call("POST", "/v1/me/rebuild");
    assert.equal(rebuilt.body.voiceProfile, "Voice: short, lowercase, dry.");
    const me = (await call("GET", "/v1/me")).body;
    assert.deepEqual(me.styleExamples, ["bet", "nah ur wild"]);
    assert.equal(me.aboutMe, "27, nyc");
    assert.equal(me.learnedExamples.filter((e) => e.source === "imported").length, 3);

    // Auto-tune now suggests sliders; app applies them and saves.
    const tuned = (await call("POST", "/v1/me/persona/autotune")).body;
    assert.equal(tuned.settings[0].key, "emoji");
    persona.sliders.emoji = tuned.settings[0].value;
    persona.toggles.lowercase = tuned.lowercase;
    assert.equal((await call("PUT", "/v1/me/persona", { persona })).body.persona.toggles.lowercase, true);

    // Action Button: auto mode, screenshot → 5 replies in the saved persona's style.
    const reply = await call("POST", "/v1/replies", { mode: "auto", tone: "me", image: img });
    assert.equal(reply.status, 200);
    assert.ok(reply.body.generationId);
    assert.equal(reply.body.replies[0].text, "reply 0 lol");

    // Keyboard: pick one, then the user's edited version.
    const g = reply.body.generationId;
    assert.equal((await call("POST", "/v1/feedback", { generationId: g, replyIndex: 0, kind: "picked" })).status, 200);
    assert.equal((await call("POST", "/v1/feedback", { generationId: g, replyIndex: 0, kind: "edited", text: "reply 0 lmao" })).status, 200);
    assert.equal((await call("POST", "/v1/feedback", { generationId: g, replyIndex: 3, kind: "rejected" })).status, 200);

    // History: mark it a match.
    assert.equal((await call("POST", "/v1/feedback", { generationId: g, replyIndex: 0, kind: "match", text: "reply 0 lmao" })).status, 200);
    const history = (await call("GET", "/v1/history")).body.items;
    assert.equal(history.length, 1); // the test drive wasn't saved
    assert.deepEqual(history[0].signals.map((s) => s.kind), ["picked", "edited", "rejected", "match"]);

    // What Rizzio knows: the win is stored as their own words and shows in the stats.
    const after = (await call("GET", "/v1/me")).body;
    assert.equal(after.stats.wins, 1);
    assert.ok(after.learnedExamples.some((e) => e.text === "reply 0 lmao" && e.source === "won"));
  } finally {
    server.close();
  }
});
