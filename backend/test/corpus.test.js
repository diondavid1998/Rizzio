import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { corpus, inspiration, isHinglish, renderInspiration } from "../src/corpus.js";
import { stripEmoji } from "../src/persona.js";

describe("built-in reference library", () => {
  test("loads the Hugging Face corpus and the Rizzio playbook", () => {
    const { docs } = corpus();
    assert.ok(docs.length > 4000);
    assert.ok(docs.some((d) => d.kind === "prompt"));
    assert.ok(docs.every((d) => d.them.length <= 200 && d.reply.length <= 160));
  });

  test("finds exchanges about the same thing", () => {
    const r = inspiration("I'm overly competitive about board games", { mode: "prompt", limit: 4 });
    assert.equal(r.length, 4);
    assert.match(r[0].reply, /Catan/);
    const chat = inspiration("I just adopted a puppy", { mode: "chat", limit: 5 });
    assert.ok(chat.some((e) => /pupp|dog/i.test(e.them + e.reply)));
  });

  test("screenshot-only requests still get a stable sample", () => {
    assert.deepEqual(inspiration("", { mode: "prompt", limit: 3 }), inspiration(undefined, { mode: "prompt", limit: 3 }));
    assert.equal(inspiration("", { mode: "prompt", limit: 3 })[0].kind, "prompt");
  });

  test("filtered for family-friendly, light topics", () => {
    const bad = /\b(sex|naked|porn|suicid|funeral|cancer)\w*/i;
    assert.ok(!corpus().docs.some((d) => bad.test(d.them) || bad.test(d.reply)));
  });

  test("Hinglish examples only for Hinglish chats", () => {
    assert.equal(isHinglish("yaar aaj office mein bohot kaam tha"), true);
    assert.equal(isHinglish("I love hiking with my dog"), false);
    const hi = inspiration("yaar aaj office mein bohot kaam tha, thak gaya", { mode: "chat", limit: 4 });
    assert.ok(hi.every((e) => isHinglish(e.them + " " + e.reply)), "Hinglish in, Hinglish out");
    const en = inspiration("work was so busy today, I'm exhausted", { mode: "chat", limit: 6 });
    assert.ok(en.every((e) => !isHinglish(e.them + " " + e.reply)), "no Hinglish for English chats");
  });

  test("feelings pull in EmpatheticDialogues examples, labelled with the feeling", () => {
    const r = inspiration("I just got promoted and I am so proud of myself", { mode: "chat", limit: 5 });
    const empathy = r.filter((e) => e.kind === "empathy");
    assert.ok(empathy.length >= 1 && empathy.length <= 3, "mixed with other sources");
    assert.match(renderInspiration(r), /They shared \(feeling \w+\)/);
  });

  test("stripEmoji", () => {
    assert.equal(stripEmoji("haha 😂 ok 👍🏽"), "haha ok");
    assert.equal(stripEmoji("👨‍👩‍👧 family day?"), "family day?");
    assert.equal(stripEmoji("call me at 10 :) #1 fan"), "call me at 10 :) #1 fan");
  });
});
