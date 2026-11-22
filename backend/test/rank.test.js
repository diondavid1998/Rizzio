import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { choose, describeTaste, emptyTaste, features, learn, tasteBoost, tasteShare } from "../src/rank.js";

const c = (text, form = "guess") => ({ text, form, angle: "x" });

describe("choosing what to show", () => {
  test("keeps the best 5 by judge score, weakest left out", () => {
    const cands = ["a", "b", "c", "d", "e", "f", "g"].map((t) => c(`reply ${t}`));
    const scores = [3, 9, 8, 2, 7, 4, 6].map((score) => ({ score, issue: "" }));
    const out = choose(cands, { scores });
    assert.deepEqual(out.map((r) => r.text), ["reply b", "reply c", "reply e", "reply g", "reply f"]);
    assert.equal(out[0].score, 9);
    const weak = choose(cands, { scores: cands.map(() => ({ score: 3, issue: "generic" })) });
    assert.equal(weak.length, 5, "always the best 5 of the candidates");
  });

  test("a stock phrase costs points; a good question back is kept", () => {
    const cands = [c("that's a bold move"), c("statement one"), c("statement two"), c("statement three"), c("statement four"), c("statement five"), c("which trail was it?", "follow_up_question")];
    const scores = [9, 8, 8, 8, 8, 8, 6].map((score) => ({ score, issue: "" }));
    const out = choose(cands, { scores, flags: [["bold move"], [], [], [], [], [], []] });
    assert.ok(out.some((r) => r.form === "follow_up_question"), "question swapped in");
    assert.notEqual(out[0].text, "that's a bold move");
  });

  test("duplicates are dropped; no judge keeps the model's order", () => {
    const out = choose([c("same thing"), c("Same thing!"), c("other"), c("third"), c("fourth")]);
    assert.deepEqual(out.map((r) => r.text), ["same thing", "other", "third", "fourth"]);
  });
});

describe("taste: the per-user ranking model", () => {
  test("features describe a reply", () => {
    const f = features(c("ok but why geese?", "comeback"));
    assert.equal(f.form_comeback, 1);
    assert.equal(f.question, 1);
    assert.equal(f.opener, 1);
    assert.equal(f.len_short, 1);
  });

  test("learns from picks and results, and its say grows with signals", () => {
    let taste = emptyTaste();
    const set = [c("you seem like a cheater at board games", "guess"), c("I love that for you!", "compliment_back"), c("what's the story there?", "follow_up_question")];
    for (let i = 0; i < 40; i++) {
      taste = learn(taste, "picked", set, 0);
      taste = learn(taste, "rejected", set, 1);
    }
    taste = learn(taste, "match", set, 0);
    assert.equal(taste.signals, 81);
    assert.ok(tasteShare(taste) > 0.3 && tasteShare(taste) <= 0.6);
    assert.ok(tasteBoost(taste, c("bet you cheat at cards", "guess")) > 0);
    assert.ok(tasteBoost(taste, c("love that so much!", "compliment_back")) < 0);
    const d = describeTaste(taste);
    assert.ok(d.likes.includes("guesss") || d.likes.some((l) => /guess/.test(l)));
    assert.ok(d.dislikes.some((l) => /compliment|exclamation/.test(l)));
    assert.equal(tasteShare(emptyTaste()), 0);
  });

  test("unknown signals and missing replies change nothing", () => {
    const t = emptyTaste();
    assert.equal(learn(t, "picked", [], 0), t);
    assert.equal(learn(t, "nonsense", [c("x")], 0), t);
  });
});

describe("variety", () => {
  test("five takes on the same idea don't all make it when there are different good ones", () => {
    const same = Array.from({ length: 5 }, (_, i) => c(`weekend is open so pitch me something and gary can vote ${i}`, "play_along"));
    const other = [c("gary sounds like the real boss of the house", "tease_back"), c("saturday farmers market then we see if gary approves?", "make_plans")];
    const scores = [...same.map(() => ({ score: 8, issue: "" })), { score: 7, issue: "" }, { score: 7, issue: "" }];
    const out = choose([...same, ...other], { scores });
    assert.ok(out.some((r) => r.form === "tease_back"));
    assert.ok(out.some((r) => r.form === "make_plans"));
    assert.ok(out.filter((r) => r.form === "play_along").length <= 3);
  });
});
