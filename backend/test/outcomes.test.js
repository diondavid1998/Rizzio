import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findOutcomes, sameMessage } from "../src/outcomes.js";

const now = Date.parse("2026-11-27T12:00:00Z");
const gen = (id, mode, replies, signals = []) => ({ id, mode, replies: replies.map((text) => ({ text })), signals, createdAt: "2026-11-26 10:00:00" });

describe("did Rizzio's line work?", () => {
  test("a sent comment that got an answer is a match; a chat line is a reply", () => {
    const history = [
      gen("g1", "prompt", ["bet you cheat at board games", "what's the story behind the goose"]),
      gen("g2", "chat", ["saturday, the tiny cafe on 5th, you're in charge of the oat milk verdict"]),
    ];
    const transcript = [
      { from: "me", text: "what's the story behind the goose?" },
      { from: "them", text: "lol his name is gary" },
      { from: "me", text: "saturday, the tiny cafe on 5th. you're in charge of the oat milk verdict" },
      { from: "them", text: "deal" },
    ];
    const found = findOutcomes(transcript, history, now);
    assert.deepEqual(found.map((f) => [f.generationId, f.replyIndex, f.kind]), [["g1", 1, "match"], ["g2", 0, "replied"]]);
  });

  test("no answer yet, an unrelated message, or an already-recorded result: nothing", () => {
    const history = [gen("g1", "prompt", ["bet you cheat at board games"], [{ kind: "match", replyIndex: 0 }]), gen("g2", "chat", ["see you thursday then"])];
    assert.deepEqual(findOutcomes([{ from: "me", text: "see you thursday then" }], history, now), [], "no reply after it");
    assert.deepEqual(findOutcomes([{ from: "me", text: "bet you cheat at board games" }, { from: "them", text: "maybe" }], history, now), [], "already counted");
    assert.deepEqual(findOutcomes([{ from: "me", text: "totally different thing" }, { from: "them", text: "ok" }], history, now), []);
    assert.ok(sameMessage("Bet you cheat at board games!", "bet you cheat at board games") > 0.9);
  });

  test("only recent lines count", () => {
    const old = { ...gen("g1", "chat", ["see you thursday then"]), createdAt: "2026-09-01 10:00:00" };
    assert.deepEqual(findOutcomes([{ from: "me", text: "see you thursday then" }, { from: "them", text: "yes" }], [old], now), []);
  });
});
