import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createApp, REBUILD_EVERY } from "../src/app.js";
import { openDb } from "../src/db.js";

const TOKEN = "test-token";
const USER = "user-1234-abcd";

/** Fake Claude: records what it was asked and returns canned answers. */
class FakeAI {
  constructor() {
    this.calls = { replies: [], profile: [], extract: [] };
  }
  async generateReplies(args) {
    this.calls.replies.push(args);
    return {
      context: "Prompt: my irrational fear — geese",
      replies: Array.from({ length: 5 }, (_, i) => ({ text: `reply ${i}`, angle: `angle ${i}` })),
    };
  }
  async rebuildProfile(args) {
    this.calls.profile.push(args);
    return `Voice: profile v${this.calls.profile.length}`;
  }
  async autoTune(args) {
    this.calls.autotune = [...(this.calls.autotune ?? []), args];
    return { settings: [{ key: "emoji", value: 5, reason: "never uses emoji" }], lowercase: true };
  }
  async extractUserMessages(args) {
    this.calls.extract.push(args);
    return ["lmaooo no way", "ok but tacos tho"];
  }
}

let server, base, ai, store;

async function call(method, path, body, { user = USER, token = TOKEN } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(user ? { "x-rizzio-user": user } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  store = openDb(":memory:");
  ai = new FakeAI();
  const app = createApp({ store, ai, appToken: TOKEN, log: { error() {} } });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

describe("auth", () => {
  test("health is public", async () => {
    const res = await fetch(base + "/health");
    assert.equal(res.status, 200);
  });
  test("rejects a wrong token", async () => {
    const r = await call("GET", "/v1/me", null, { token: "nope" });
    assert.equal(r.status, 401);
  });
  test("requires a user id", async () => {
    const r = await call("GET", "/v1/me", null, { user: null });
    assert.equal(r.status, 400);
  });
});

describe("replies", () => {
  test("validates input", async () => {
    assert.equal((await call("POST", "/v1/replies", { mode: "nope", text: "x" })).status, 400);
    assert.equal((await call("POST", "/v1/replies", { mode: "prompt" })).status, 400);
    assert.equal((await call("POST", "/v1/replies", { mode: "prompt", image: { data: "x", mediaType: "image/bmp" } })).status, 400);
  });

  test("returns 5 replies with a generation id and sends the user's memory", async () => {
    await call("PUT", "/v1/me", { aboutMe: "nurse in nyc, climbs", styleExamples: ["ok but who hurt the geese"] });
    await settle();
    const r = await call("POST", "/v1/replies", { mode: "prompt", tone: "flirty", text: "geese. they know what they did." });
    assert.equal(r.status, 200);
    assert.equal(r.body.replies.length, 5);
    assert.ok(r.body.generationId);
    const sent = ai.calls.replies[0];
    assert.match(sent.memory, /nurse in nyc/);
    assert.match(sent.memory, /who hurt the geese/);
    assert.match(sent.memory, /Voice: profile v1/); // profile learned from the PUT
    assert.match(sent.requestText, /Tone for this request: flirty/);
    assert.match(sent.memory, /Persona settings/);
  });
});

describe("learning loop", () => {
  async function generate() {
    return (await call("POST", "/v1/replies", { mode: "chat", text: "hey whats up" })).body.generationId;
  }

  test("picked, edited and won messages become examples, strongest first", async () => {
    const g1 = await generate();
    await call("POST", "/v1/feedback", { generationId: g1, replyIndex: 2, kind: "picked" });
    const g2 = await generate();
    await call("POST", "/v1/feedback", { generationId: g2, replyIndex: 0, kind: "edited", text: "my own version lol" });
    await call("POST", "/v1/feedback", { generationId: g2, replyIndex: 0, kind: "match" });

    const me = (await call("GET", "/v1/me")).body;
    const bySource = Object.fromEntries(me.learnedExamples.map((e) => [e.text, e.source]));
    assert.equal(bySource["reply 2"], "picked");
    assert.equal(bySource["my own version lol"], "won"); // edited, then got a match → upgraded
    assert.equal(me.stats.wins, 1);

    await call("POST", "/v1/replies", { mode: "chat", text: "next" });
    const memory = ai.calls.replies.at(-1).memory;
    assert.match(memory, /\[WORKED\] my own version lol/);
    assert.doesNotMatch(memory, /reply 2/); // AI-written pick: used for learning, not quoted as their voice
  });

  test("re-learns the voice profile after enough feedback", async () => {
    const g = await generate();
    for (let i = 0; i < REBUILD_EVERY - 1; i++) {
      await call("POST", "/v1/feedback", { generationId: g, replyIndex: i % 5, kind: "rejected" });
    }
    await settle();
    assert.equal(ai.calls.profile.length, 0);
    await call("POST", "/v1/feedback", { generationId: g, replyIndex: 1, kind: "picked" });
    await settle();
    assert.equal(ai.calls.profile.length, 1);
    assert.match(ai.calls.profile[0].evidence, /REJECTED: "reply 0"/);
    assert.match(ai.calls.profile[0].evidence, /PICKED: "reply 1"/);
    assert.equal((await call("GET", "/v1/me")).body.voiceProfile, "Voice: profile v1");
  });

  test("feedback validation", async () => {
    assert.equal((await call("POST", "/v1/feedback", { kind: "loved" })).status, 400);
    assert.equal((await call("POST", "/v1/feedback", { kind: "picked", generationId: "missing" })).status, 404);
    const g = await generate();
    assert.equal((await call("POST", "/v1/feedback", { kind: "edited", generationId: g })).status, 400);
  });

  test("users can't see each other's generations", async () => {
    const g = await generate();
    const r = await call("POST", "/v1/feedback", { kind: "picked", generationId: g, replyIndex: 0 }, { user: "someone-else-999" });
    assert.equal(r.status, 404);
  });

  test("learns from a chat screenshot", async () => {
    const r = await call("POST", "/v1/learn/screenshot", { image: { data: "aGk=", mediaType: "image/png" } });
    assert.deepEqual(r.body.learned, ["lmaooo no way", "ok but tacos tho"]);
    const me = (await call("GET", "/v1/me")).body;
    assert.equal(me.learnedExamples.filter((e) => e.source === "imported").length, 2);
  });

  test("history shows generations with their feedback", async () => {
    const g = await generate();
    await call("POST", "/v1/feedback", { generationId: g, replyIndex: 3, kind: "picked" });
    const items = (await call("GET", "/v1/history")).body.items;
    assert.equal(items[0].id, g);
    assert.equal(items[0].signals[0].kind, "picked");
    assert.equal(items[0].signals[0].replyIndex, 3);
  });

  test("reset forgets learning but keeps hand-written examples", async () => {
    await call("PUT", "/v1/me", { styleExamples: ["seed one"] });
    const g = await generate();
    await call("POST", "/v1/feedback", { generationId: g, replyIndex: 0, kind: "picked" });
    await settle();
    await call("DELETE", "/v1/me/memory");
    const me = (await call("GET", "/v1/me")).body;
    assert.deepEqual(me.styleExamples, ["seed one"]);
    assert.equal(me.learnedExamples.length, 0);
    assert.equal(me.voiceProfile, "");
  });
});

describe("review fixes", () => {
  test("auto mode asks the AI to detect profile vs chat", async () => {
    const r = await call("POST", "/v1/replies", { mode: "auto", text: "hey" });
    assert.equal(r.status, 200);
    assert.match(ai.calls.replies.at(-1).requestText, /first work out whether this is a dating profile/);
  });

  test("AI-written picks aren't fed back as the user's voice, but their own words are", async () => {
    const g = (await call("POST", "/v1/replies", { mode: "chat", text: "hi" })).body.generationId;
    await call("POST", "/v1/feedback", { generationId: g, replyIndex: 1, kind: "picked" });
    await call("POST", "/v1/feedback", { generationId: g, replyIndex: 2, kind: "edited", text: "nah ur wild for that" });
    await call("POST", "/v1/replies", { mode: "chat", text: "next" });
    const memory = ai.calls.replies.at(-1).memory;
    assert.doesNotMatch(memory, /reply 1/);
    assert.match(memory, /nah ur wild for that/);
  });

  test("rate limits AI calls per user", async () => {
    server.close();
    const app = createApp({ store, ai, appToken: TOKEN, log: { error() {} }, hourlyLimit: 2 });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await call("POST", "/v1/replies", { mode: "auto", text: "a" })).status, 200);
    assert.equal((await call("POST", "/v1/replies", { mode: "auto", text: "b" })).status, 200);
    assert.equal((await call("POST", "/v1/replies", { mode: "auto", text: "c" })).status, 429);
    assert.equal((await call("POST", "/v1/replies", { mode: "auto", text: "d" }, { user: "other-user-1234" })).status, 200);
  });
});

describe("free mode (Apple Intelligence on the phone)", () => {
  test("stores phone-written replies, examples and profile without calling Claude", async () => {
    const g = await call("POST", "/v1/generations", {
      mode: "prompt", tone: "me", context: "Prompt: geese",
      replies: [{ text: "who hurt you, the geese?", angle: "tease" }, { text: "bad", extra: 1 }, { nope: true }],
    });
    assert.equal(g.status, 200);
    assert.ok(g.body.generationId);
    assert.equal((await call("POST", "/v1/feedback", { generationId: g.body.generationId, replyIndex: 0, kind: "picked" })).status, 200);
    assert.equal((await call("GET", "/v1/history")).body.items[0].replies.length, 2);

    const ex = await call("POST", "/v1/me/examples", { texts: ["lowkey yes", "", 5, "say less"] });
    assert.equal(ex.body.added, 2);
    assert.equal((await call("PUT", "/v1/me/profile", { voiceProfile: "short, lowercase" })).status, 200);

    const me = (await call("GET", "/v1/me")).body;
    assert.equal(me.voiceProfile, "short, lowercase");
    assert.ok(me.learnedExamples.some((e) => e.text === "say less" && e.source === "imported"));
    assert.equal(ai.calls.replies.length + ai.calls.profile.length + ai.calls.extract.length, 0);
  });

  test("validates free-mode input", async () => {
    assert.equal((await call("POST", "/v1/generations", { mode: "prompt", replies: [] })).status, 400);
    assert.equal((await call("PUT", "/v1/me/profile", { voiceProfile: " " })).status, 400);
  });
});

describe("persona", () => {
  test("starts with defaults, saves, and cleans bad values", async () => {
    const first = (await call("GET", "/v1/me/persona")).body;
    assert.equal(first.persona.sliders.flirt, 55);
    assert.equal(first.sliders.length, 12);

    const saved = await call("PUT", "/v1/me/persona", {
      persona: { sliders: { flirt: 140, humor: 10, bogus: 50 }, toggles: { lowercase: true }, goal: "date", avoid: "my ex" },
    });
    assert.equal(saved.body.persona.sliders.flirt, 100); // clamped
    assert.equal(saved.body.persona.sliders.humor, 10);
    assert.equal(saved.body.persona.sliders.bogus, undefined);
    assert.equal(saved.body.persona.goal, "date");

    const again = (await call("GET", "/v1/me/persona")).body.persona;
    assert.equal(again.toggles.lowercase, true);
    assert.equal(again.avoid, "my ex");
  });

  test("saved persona shapes every reply", async () => {
    await call("PUT", "/v1/me/persona", { persona: { sliders: { emoji: 0 }, toggles: { lowercase: true }, avoid: "politics" } });
    await call("POST", "/v1/replies", { mode: "prompt", text: "I love hiking" });
    const memory = ai.calls.replies.at(-1).memory;
    assert.match(memory, /emoji: 0\/100/);
    assert.match(memory, /Write in all lowercase/);
    assert.match(memory, /Never bring up: politics/);
    assert.match(ai.calls.replies.at(-1).requestText, /follow the persona settings/);
  });

  test("test drive uses unsaved settings and isn't saved or learned from", async () => {
    const r = await call("POST", "/v1/replies", {
      mode: "prompt", text: "I love hiking", preview: true, persona: { sliders: { flirt: 3 } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.generationId, null);
    assert.match(ai.calls.replies.at(-1).memory, /flirt: 3\/100/);
    assert.equal((await call("GET", "/v1/history")).body.items.length, 0);
    assert.equal((await call("GET", "/v1/me/persona")).body.persona.sliders.flirt, 55); // not saved
  });

  test("auto-tune needs training data first, then suggests values", async () => {
    assert.equal((await call("POST", "/v1/me/persona/autotune")).status, 409);
    await call("PUT", "/v1/me", { styleExamples: ["lol ok bet"] });
    const r = await call("POST", "/v1/me/persona/autotune");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.settings[0], { key: "emoji", value: 5, reason: "never uses emoji" });
    assert.match(ai.calls.autotune[0].evidence, /lol ok bet/);
  });
});
