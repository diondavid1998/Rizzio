import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { corpus, inspiration, renderInspiration } from "../src/corpus.js";
import { stripEmoji } from "../src/persona.js";

describe("built-in reference library", () => {
  test("loads the Rizzio playbook (Hinge comments and chat moves)", () => {
    const { docs } = corpus();
    assert.ok(docs.length > 100 && docs.length < 1000);
    assert.ok(docs.some((d) => d.kind === "prompt"));
    assert.ok(docs.every((d) => d.them.length <= 200 && d.reply.length <= 160));
  });

  test("finds exchanges about the same thing", () => {
    const r = inspiration("I'm overly competitive about board games", { mode: "prompt", limit: 4 });
    assert.equal(r.length, 4);
    assert.match(r[0].reply, /Catan/);
    const chat = inspiration("lol", { mode: "chat", limit: 3 });
    assert.match(chat[0].reply, /that lol is doing a lot of work/);
  });

  test("screenshot-only requests still get a stable sample", () => {
    assert.deepEqual(inspiration("", { mode: "prompt", limit: 3 }), inspiration(undefined, { mode: "prompt", limit: 3 }));
    assert.equal(inspiration("", { mode: "prompt", limit: 3 })[0].kind, "prompt");
  });

  test("filtered for family-friendly, light topics", () => {
    const bad = /\b(sex|naked|porn|suicid|funeral|cancer)\w*/i;
    assert.ok(!corpus().docs.some((d) => bad.test(d.them) || bad.test(d.reply)));
  });

  test("only dating-specific datasets load; the generic ones stay out of replies", () => {
    const sources = new Set(corpus().docs.map((d) => d.source));
    assert.ok(sources.size >= 1 && sources.size <= 3, `got ${[...sources].join(", ")}`);
    assert.ok(!corpus().docs.some((d) => d.kind === "empathy" || d.kind === "movie"));
  });

  test("stripEmoji", () => {
    assert.equal(stripEmoji("haha 😂 ok 👍🏽"), "haha ok");
    assert.equal(stripEmoji("👨‍👩‍👧 family day?"), "family day?");
    assert.equal(stripEmoji("call me at 10 :) #1 fan"), "call me at 10 :) #1 fan");
  });
});
