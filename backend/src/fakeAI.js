// Demo/test mode (RIZZIO_FAKE_AI=1): canned, instant answers in the real response shapes.
// Used by the automated iPhone UI tests so they run without a Claude key or cost.
export class FakeAI {
  async generateReplies({ memory, requestText }) {
    const lower = memory.includes("Write in all lowercase");
    const context = requestText.includes("draft") ? "Your draft" : "Prompt: Typical Sunday";
    return {
      context,
      replies: [1, 2, 3, 4, 5].map((n) => ({
        text: lower ? `fake reply ${n} lol` : `Fake reply ${n}`,
        form: ["tease_back", "answer_and_ask", "comeback", "callback", "make_plans"][n - 1],
        angle: ["playful tease", "curious", "bold", "callback", "date ask"][n - 1],
      })),
      read: { kind: "profile_prompt", questions: [], needs: "riff on their answer", as_user: "they'd tease first", side_topic: "", sides: [], visible_hooks: [] },
    };
  }

  async rewriteTexts({ texts }) {
    return texts.map((t) => t.slice(0, 140));
  }

  async rewriteWithout({ texts, phrases }) {
    return texts.map((t) => phrases.reduce((s, p) => s.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim(), t));
  }

  async suggestAbout() {
    return "27, Chicago, nurse, into climbing and tacos, dry humor";
  }

  async rebuildProfile({ evidence }) {
    const own = (evidence.match(/\[(?:OWN WORDS|WON)\]/g) ?? []).length;
    return `Voice: test profile built from ${own} of your messages.`;
  }

  async autoTune() {
    return {
      settings: [
        { key: "emoji", value: 0, reason: "never uses emoji" },
        { key: "length", value: 15, reason: "keeps it short" },
      ],
      lowercase: true,
    };
  }

  async extractUserMessages() {
    return ["lmao no", "ok but tacos tho"];
  }
}
