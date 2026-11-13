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
      replies: this.replyTexts?.map((text) => ({ text, angle: "x" })) ?? Array.from({ length: 5 }, (_, i) => ({ text: `reply ${i}`, angle: `angle ${i}` })),
    };
  }
  async rewriteWithout(args) {
    this.calls.rewrite = [...(this.calls.rewrite ?? []), args];
    return args.texts.map((t) => t.replace(/that's a bold pick,? ?/i, "").replace(/hostage situation/i, "problem"));
  }
  async suggestAbout(args) {
    this.calls.about = [...(this.calls.about ?? []), args];
    return "27, Chicago, nurse, into climbing";
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
    assert.match(sent.requestText, /not who is writing it/);
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

  test("keyboard chat follow-ups and the Humor tone reach the model", async () => {
    await call("POST", "/v1/replies", {
      mode: "prompt", tone: "humor", text: "Two truths and a lie: I have a dog, I hate pizza, I've been to Peru",
      instruction: "make it about the dog", previous: ["reply 0", "reply 1"],
    });
    const sent = ai.calls.replies.at(-1).requestText;
    assert.match(sent, /laugh-out-loud funny/);
    assert.match(sent, /asked for this change: "make it about the dog"/);
    assert.match(sent, /earlier suggestions[\s\S]*- reply 1/);
    await call("POST", "/v1/replies", { mode: "prompt", tone: "question", text: "I love hiking" });
    assert.match(ai.calls.replies.at(-1).requestText, /every message asks them a question/);
    assert.match(ai.calls.replies.at(-1).requestText, /must ask them a question and end with a question mark/);
    await call("POST", "/v1/replies", { mode: "prompt", tone: "witty", text: "I love hiking" });
    assert.match(ai.calls.replies.at(-1).requestText, /clever wordplay/);
    assert.doesNotMatch(ai.calls.replies.at(-1).requestText, /asked for this change/);
  });

  test("the user's own related messages steer wording; the library only gives ideas", async () => {
    // Older taco messages, then 30 newer ones: the tacos fall outside the 25 always shown and must be pulled in by topic.
    store.addExamplesBulk(USER, ["tacos are a personality trait and I have it bad", "honestly al pastor tacos or nothing"], "imported");
    store.addExamplesBulk(USER, Array.from({ length: 30 }, (_, i) => `filler message number ${i} about nothing much`), "imported");
    await call("POST", "/v1/replies", { mode: "chat", text: "Them: ok what's your go-to taco order" });
    const sent = ai.calls.replies.at(-1);
    assert.match(sent.requestText, /Things the user has said before that relate to this/);
    assert.match(sent.requestText, /al pastor tacos or nothing/);
    assert.match(sent.requestText, /tacos are a personality trait/);
    assert.doesNotMatch(sent.requestText.split("Things the user has said")[1].split("\n\n")[0], /filler message/);
    const free = await call("POST", "/v1/inspiration", { text: "what's your go-to taco order", mode: "chat" });
    assert.ok(free.body.own.includes("tacos are a personality trait and I have it bad"), "free mode gets them too");
  });

  test("earlier screenshots of the same profile are sent along (max 3)", async () => {
    const img = { data: Buffer.from("x").toString("base64"), mediaType: "image/jpeg" };
    await call("POST", "/v1/replies", { mode: "auto", image: img, earlierImages: [img, img, img, img, img] });
    const sent = ai.calls.replies.at(-1);
    assert.equal(sent.earlier.length, 3);
    assert.match(sent.requestText, /3 earlier screenshots of what's probably the same profile/);
    await call("POST", "/v1/replies", { mode: "auto", text: "My simple pleasures: night-shift tacos", earlierImages: [img, img] });
    assert.equal(ai.calls.replies.at(-1).earlier.length, 2, "a copied prompt is read with the recent profile screens");
    assert.match(ai.calls.replies.at(-1).requestText, /reply to the copied text/);
  });

  test("Reply to their photos switch: off means prompts and text only", async () => {
    await call("PUT", "/v1/me/persona", { persona: { toggles: { noPhotos: true } } });
    await call("POST", "/v1/replies", { mode: "prompt", text: "Typical Sunday: church at 11" });
    assert.match(ai.calls.replies.at(-1).memory, /Ignore their photos completely/);
    await call("PUT", "/v1/me/persona", { persona: { toggles: { noPhotos: false } } });
    await call("POST", "/v1/replies", { mode: "prompt", text: "Typical Sunday: church at 11" });
    assert.doesNotMatch(ai.calls.replies.at(-1).memory, /Ignore their photos/);
  });

  test("About you can be drafted from the user's messages, without saving it", async () => {
    assert.equal((await call("POST", "/v1/me/about/suggest")).status, 409, "needs something to go on");
    store.addExamplesBulk(USER, ["just got off a 12 hour shift at the hospital", "climbing gym tonight?"], "imported");
    const r = await call("POST", "/v1/me/about/suggest");
    assert.equal(r.status, 200);
    assert.equal(r.body.about, "27, Chicago, nurse, into climbing");
    assert.match(ai.calls.about.at(-1).evidence, /12 hour shift/);
    assert.equal((await call("GET", "/v1/me")).body.aboutMe, "", "not saved until the user taps Save");
  });

  test("Pick a side: the user's stance on the topic shapes all 5 replies", async () => {
    await call("POST", "/v1/replies", { mode: "prompt", text: "Hot take: pineapple belongs on pizza", stance: "against", stanceTopic: "pineapple on pizza" });
    const sent = ai.calls.replies.at(-1).requestText;
    assert.match(sent, /picked a side on "pineapple on pizza": AGAINST/);
    assert.match(sent, /playfully disagree/);
    await call("POST", "/v1/replies", { mode: "prompt", text: "Hot take: pineapple belongs on pizza", stance: "both", stanceTopic: "pineapple on pizza" });
    assert.match(ai.calls.replies.at(-1).requestText, /some of the 5 take the for side and some take the against side/);
    await call("POST", "/v1/replies", { mode: "prompt", text: "Hot take: pineapple belongs on pizza", stance: "sideways" });
    assert.doesNotMatch(ai.calls.replies.at(-1).requestText, /picked a side/);
  });

  test("catchphrases Rizzio keeps repeating (that the user never says) are steered away from", async () => {
    ai.replyTexts = ["ok that slaps fr honestly", "ok but why", "tacos tonight?", "lol fair", "say more"];
    for (let i = 0; i < 3; i++) await call("POST", "/v1/replies", { mode: "prompt", text: `prompt number ${i}` });
    await call("POST", "/v1/replies", { mode: "prompt", text: "another prompt" });
    const sent = ai.calls.replies.at(-1).requestText;
    assert.match(sent, /overusing for this user[^\n]*"slaps fr honestly"/);
    // a phrase the user really says is never flagged
    store.addExamplesBulk(USER, ["ok that slaps fr honestly"], "imported");
    await call("POST", "/v1/replies", { mode: "prompt", text: "one more prompt" });
    assert.doesNotMatch(ai.calls.replies.at(-1).requestText, /slaps fr/);
  });

  test("a reply that still uses a stock phrase is rewritten; ones the user says are left alone", async () => {
    ai.replyTexts = ["that's a bold pick, why pineapple", "ok but why", "this is a hostage situation", "lol fair", "say more"];
    const r = await call("POST", "/v1/replies", { mode: "prompt", text: "pineapple pizza" });
    assert.deepEqual(ai.calls.rewrite.at(-1).texts, ["that's a bold pick, why pineapple", "this is a hostage situation"]);
    assert.equal(r.body.replies[0].text, "why pineapple");
    assert.equal(r.body.replies[2].text, "this is a problem");
    assert.equal(r.body.replies[1].text, "ok but why");
    store.addExamplesBulk(USER, ["9am is a hostage situation", "that's a bold pick"], "imported");
    const before = ai.calls.rewrite.length;
    await call("POST", "/v1/replies", { mode: "prompt", text: "pineapple pizza again" });
    assert.equal(ai.calls.rewrite.length, before, "the user's own phrases are fine");
  });

  test("openers: the model sees how the user uses them; ones they never use are blocked", async () => {
    const mine = ["wait you've been to peru??", "wait what, since when", "lowkey want to try that", "lol fair enough", "ok but why tho"];
    const filler = Array.from({ length: 40 }, (_, i) => `plain message ${i} about my day`);
    store.addExamplesBulk(USER, [...filler, ...mine], "imported");
    ai.replyTexts = ["ngl that sounds fun", "wait you went alone?", "lowkey jealous", "ok but which trail", "lol fair"];
    const r = await call("POST", "/v1/replies", { mode: "chat", text: "Them: just got back from hiking in Peru" });
    const memory = ai.calls.replies.at(-1).memory;
    assert.match(memory, /How the user uses openers/);
    assert.match(memory, /"wait" \(2x\), e\.g\./);
    assert.match(memory, /Never used by the user, so don't use:[^\n]*"ngl"/);
    assert.ok(ai.calls.rewrite.at(-1).texts.includes("ngl that sounds fun"), "a reply with an opener they never use is rewritten");
    assert.ok(!ai.calls.rewrite.at(-1).texts.includes("wait you went alone?"), "their own openers are fine");
  });

  test("an opener in more than 2 of the 5 replies is dropped from the extras", async () => {
    ai.replyTexts = ["lol same", "lol rough one", "lol you get to rest now", "lol tired is right", "how was it"];
    await call("POST", "/v1/replies", { mode: "chat", text: "Them: just got back from work" });
    assert.deepEqual(ai.calls.rewrite.at(-1).texts, ["lol you get to rest now", "lol tired is right"]);
    assert.deepEqual(ai.calls.rewrite.at(-1).phrases, ["lol"]);
  });

  test("keyboard length meter sets how long replies are", async () => {
    await call("POST", "/v1/replies", { mode: "prompt", text: "I love hiking", length: "phrase" });
    assert.match(ai.calls.replies.at(-1).requestText, /Length for this request: a phrase: 1-5 words/);
    await call("POST", "/v1/replies", { mode: "prompt", text: "I love hiking", length: "long" });
    assert.match(ai.calls.replies.at(-1).requestText, /25-50 words/);
    await call("POST", "/v1/replies", { mode: "prompt", text: "I love hiking", length: "auto" });
    assert.doesNotMatch(ai.calls.replies.at(-1).requestText, /Length for this request/);
  });

  test("No emoji toggle: the model is told, and any emoji that slip through are removed", async () => {
    ai.replyTexts = ["ok but who hurt you 😂😂", "say less 👍🏽 friday?", "🇯🇵 trip soon?", "no emoji here :)", "❤️"];
    await call("PUT", "/v1/me/persona", { persona: { toggles: { noEmoji: true } } });
    const r = await call("POST", "/v1/replies", { mode: "prompt", text: "I love hiking" });
    assert.match(ai.calls.replies.at(-1).memory, /emoji: OFF/);
    assert.deepEqual(r.body.replies.map((x) => x.text), ["ok but who hurt you", "say less friday?", "trip soon?", "no emoji here :)"]);
    await call("PUT", "/v1/me/persona", { persona: { toggles: { noEmoji: false } } });
    const withEmoji = await call("POST", "/v1/replies", { mode: "prompt", text: "I love hiking" });
    assert.equal(withEmoji.body.replies[0].text, "ok but who hurt you 😂😂");
  });

  test("replies include relevant reference exchanges from the built-in library", async () => {
    await call("POST", "/v1/replies", { mode: "prompt", text: "My most irrational fear: geese" });
    const sent = ai.calls.replies.at(-1).requestText;
    assert.match(sent, /Reference exchanges \(from Rizzio's library, NOT the user's voice\)/);
    assert.match(sent, /geese have chosen violence/);
    assert.doesNotMatch(ai.calls.replies.at(-1).memory, /Reference exchanges/); // kept out of the cached memory
    const free = await call("POST", "/v1/inspiration", { text: "just got back from a hike with my dog", mode: "chat", limit: 3 });
    assert.equal(free.status, 200);
    assert.equal(free.body.items.length, 3);
    assert.ok(free.body.items.every((e) => e.them && e.reply));
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
