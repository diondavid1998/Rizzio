import Anthropic from "@anthropic-ai/sdk";
import { SLIDERS } from "./persona.js";
import { ABOUT_SYSTEM, AUTOTUNE_SYSTEM, EXTRACT_SYSTEM, JUDGE_SYSTEM, PROFILE_SYSTEM, REPLY_SYSTEM } from "./prompts.js";

/** How a reply responds to what was said. The model picks one per reply and must use at least 4 different ones. */
export const REPLY_FORMS = [
  "answer", "answer_and_ask", "play_along", "comeback", "tease_back", "agree_and_raise", "playful_disagree",
  "guess", "follow_up_question", "callback", "story", "compliment_back", "make_plans", "hook", "saved_line", "joke",
];
/** Where a conversation is, so replies aim one step forward (TinderGPT-style stage tracking, read per screenshot). */
export const STAGES = ["first_comment", "getting_to_know", "building_rapport", "ready_to_ask_out", "making_plans", "reviving", "other"];
/** Candidates written per request; the judge keeps the best (up to 5). */
export const CANDIDATES = 12;
export const MESSAGE_KINDS = [
  "profile_prompt", "profile_question_for_user", "profile_wants_from_user", "photo", "question", "several_questions", "rhetorical_question", "challenge_or_hot_take",
  "tease", "story_or_statement", "compliment", "making_plans", "low_effort", "mixed",
];

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    read: {
      type: "object",
      description: "Fill this in first: who they are, what they sent and what a good reply has to do.",
      properties: {
        person: { type: "string", description: "Under 50 words. Everything known about the other person from the screenshots or chat: name, age, job, place, each prompt and answer, what the photos show, their vibe. Empty if nothing is known." },
        hook: { type: "string", description: "Under 30 words. The prompt, photo or message you're replying to, quoted word for word, and why it's the best hook." },
        visible_hooks: { type: "array", items: { type: "string" }, description: "Every prompt or photo on the screen now (the last screenshot) that could be replied to. A prompt is its question, a colon, then their answer copied word for word exactly as written (no paraphrase, no summary, nothing added), e.g. 'A life goal of mine: visit every national park'. A photo is 'Photo: ' plus what it plainly shows. Empty for chats." },
        kind: { type: "string", enum: MESSAGE_KINDS },
        transcript: {
          type: "array",
          description: "For a chat screenshot: every message bubble top to bottom, copied word for word, with who sent it (right side = me, left = them). Empty for a dating profile.",
          items: {
            type: "object",
            properties: { from: { type: "string", enum: ["me", "them"] }, text: { type: "string" } },
            required: ["from", "text"],
            additionalProperties: false,
          },
        },
        stage: { type: "string", enum: STAGES, description: "Where the conversation is. A dating-profile comment is first_comment." },
        questions: { type: "array", items: { type: "string" }, description: "Every question they asked that needs an answer (empty if none)." },
        needs: { type: "string", description: "One short line (under 20 words): what a good reply has to do here." },
        her_humor: { type: "string", description: "The kind of humor they signal they like, from their prompts, how they write and what they say they're into: e.g. 'puns and dad jokes', 'dry and sarcastic', 'dark', 'goofy and silly', 'banter and roasting', 'wants someone who makes her laugh'. Empty if nothing signals it." },
        her_wants: { type: "string", description: "What they signal they want from whoever messages them (what would impress them): e.g. 'makes her laugh', 'confidence', 'a real plan', 'depth', 'adventure', 'shared nerdiness'. Empty if unclear." },
        play: { type: "string", description: "The one insight all 5 replies build on: who is asking whom for what, and the clever or charming angle on it. E.g. 'She wants a plan and someone calm: act calm while obviously having a plan.' Decide this before writing anything." },
        side_topic: { type: "string", description: "The take the user could agree or disagree with, in 2-6 words. For a dating-profile prompt that states something, fill it with the claim, preference or choice in their answer (e.g. 'pineapple on pizza', '11am church over 9am', 'naps after the market'). Empty when the prompt is a question for the user to answer. In a chat, only when they state an opinion or preference; otherwise empty." },
        sides: {
          type: "array",
          description: "Always 2-4 options, never empty. With a side_topic: ways the user could come at it, labelled to fit this exact take (e.g. 'Team 11am' / 'Team 9am' / 'Church on a Sunday?', 'Agree' / 'Disagree', 'Defend naps' / 'Attack naps', 'Bring the coffee' / 'Bring two coffees'). Without a take: ways to reply that fit this message (e.g. 'Straight answer' / 'Playful answer' / 'Answer and flip it').",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "1-4 words, specific to this take (for Two truths and a lie: \"Lie: \" plus the statement in a few words)." },
              how: { type: "string", description: "One line: how replies taking this side should come at it." },
            },
            required: ["label", "how"],
            additionalProperties: false,
          },
        },
      },
      required: ["person", "hook", "visible_hooks", "kind", "transcript", "stage", "questions", "needs", "her_humor", "her_wants", "play", "side_topic", "sides"],
      additionalProperties: false,
    },
    context: { type: "string", description: "One short line naming what you replied to, using their exact words (e.g. 'Replying to: A life goal of mine: visit every national park')." },
    replies: {
      type: "array",
      description: `Exactly ${CANDIDATES} different candidate messages, best first. Always ${CANDIDATES}, even for a short message.`,
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "The message exactly as it should be sent." },
          form: { type: "string", enum: REPLY_FORMS, description: "How this reply responds to what was said." },
          angle: { type: "string", description: "2-4 word label for the approach, shown to the user." },
          option: { type: "string", description: "Which of read.sides this candidate takes: that option's label copied exactly. Empty if none fits." },
        },
        required: ["text", "form", "angle", "option"],
        additionalProperties: false,
      },
    },
  },
  required: ["read", "context", "replies"],
  additionalProperties: false,
};

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer", description: "The candidate's number." },
          issue: { type: "string", description: "The main problem in a few words, or empty if none." },
          score: { type: "integer", description: "1-10." },
        },
        required: ["n", "issue", "score"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores"],
  additionalProperties: false,
};

const PROFILE_SCHEMA = {
  type: "object",
  properties: { profile: { type: "string" } },
  required: ["profile"],
  additionalProperties: false,
};

const EXTRACT_SCHEMA = {
  type: "object",
  properties: { messages: { type: "array", items: { type: "string" } } },
  required: ["messages"],
  additionalProperties: false,
};

const AUTOTUNE_SCHEMA = {
  type: "object",
  properties: {
    settings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", enum: SLIDERS.map((s) => s.key) },
          value: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["key", "value", "reason"],
        additionalProperties: false,
      },
    },
    lowercase: { type: "boolean" },
  },
  required: ["settings", "lowercase"],
  additionalProperties: false,
};

export class AIError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Claude calls. Swap in a fake with the same three methods for tests. */
export class ClaudeAI {
  constructor({ apiKey, model, plusModel }) {
    this.client = new Anthropic({ apiKey, maxRetries: 4 }); // ride out brief "overloaded" errors
    // Premium = Claude Haiku (fast, cheap); Premium Plus = Claude Sonnet, which reads what a prompt is really
    // asking far better. RIZZIO_MODEL / RIZZIO_PLUS_MODEL override them.
    this.model = model || "claude-haiku-5-5";
    this.plusModel = plusModel || "claude-sonnet-5-5";
    this.workingVariants = new Map(); // per model: the request shape that model's API accepts
  }

  /**
   * Request shapes to try, newest features first. If Claude's API rejects one with a 400
   * (e.g. a beta this account or model doesn't have), the next, simpler shape is used,
   * and the one that works is remembered so later calls go straight to it.
   */
  static VARIANTS = ["full", "no-fallback", "plain-json"];

  #request(variant, { system, content, schema, effort, model = this.model }) {
    const base = { model, max_tokens: 8000, system, messages: [{ role: "user", content }] };
    if (variant === "full") {
      return this.client.beta.messages.create({
        ...base,
        // If the model declines, the API retries on a fallback model automatically.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort, format: { type: "json_schema", schema } },
      });
    }
    if (variant === "no-fallback") {
      return this.client.messages.create({ ...base, output_config: { effort, format: { type: "json_schema", schema } } });
    }
    // Most compatible: ask for JSON in the prompt and parse it from the text.
    const instruction = `Reply with only a JSON object (no other text) matching this JSON schema:\n${JSON.stringify(schema)}`;
    return this.client.messages.create({
      ...base,
      messages: [{ role: "user", content: [...content, { type: "text", text: instruction }] }],
    });
  }

  async #call(args) {
    const model = args.model ?? this.model;
    const start = ClaudeAI.VARIANTS.indexOf(this.workingVariants.get(model) ?? "full");
    let response;
    let lastBadRequest = null;
    for (const variant of ClaudeAI.VARIANTS.slice(start)) {
      try {
        response = await this.#request(variant, args);
        if (this.workingVariants.get(model) !== variant) {
          if (lastBadRequest) console.warn(`Claude request works with variant "${variant}"; using it from now on.`);
          this.workingVariants.set(model, variant);
        }
        break;
      } catch (err) {
        if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(String(err.message))) {
          throw new AIError("Rizzio's Claude account is out of credits. Add credits at console.anthropic.com → Plans & Billing.", 402);
        }
        if (err instanceof Anthropic.BadRequestError) {
          lastBadRequest = err;
          console.error(`Claude rejected the "${variant}" request (400): ${err.message}`);
          continue;
        }
        if (err instanceof Anthropic.RateLimitError) throw new AIError("Busy right now, try again in a few seconds.", 429);
        if (err instanceof Anthropic.AuthenticationError) throw new AIError("The server's Claude API key is invalid.", 500);
        if (err instanceof Anthropic.PermissionDeniedError) throw new AIError("The server's Claude API key isn't allowed to use this model.", 500);
        if (err instanceof Anthropic.NotFoundError) throw new AIError(`Claude model "${model}" wasn't found. Check RIZZIO_MODEL / RIZZIO_PLUS_MODEL.`, 500);
        if (err instanceof Anthropic.APIError) throw new AIError(`AI error (${err.status}): ${String(err.message).slice(0, 300)}`, 502);
        throw new AIError("Couldn't reach the AI.", 502);
      }
    }
    if (!response) {
      throw new AIError(`AI error (400): ${String(lastBadRequest?.message ?? "request rejected").slice(0, 300)}`, 502);
    }
    if (response.stop_reason === "refusal") throw new AIError("The AI declined this one. Try a different screenshot or tone.", 422);
    const block = response.content.find((b) => b.type === "text");
    if (!block) throw new AIError("The AI returned nothing.", 502);
    try {
      return JSON.parse(block.text);
    } catch {
      // Plain-JSON mode can wrap the object in prose or code fences: take the outermost {...}.
      const i = block.text.indexOf("{");
      const j = block.text.lastIndexOf("}");
      try {
        if (i >= 0 && j > i) return JSON.parse(block.text.slice(i, j + 1));
      } catch { /* fall through */ }
      throw new AIError("Couldn't read the AI's answer. Try again.", 502);
    }
  }

  static #image(image) {
    return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } };
  }

  /** memory: the user's rendered voice profile + examples. */
  /** earlier: screenshots taken just before this one (same profile, scrolled), oldest first. */
  /** plus: Premium Plus, written by the stronger model. */
  async generateReplies({ memory, requestText, image, earlier = [], plus = false, effort = "medium" }) {
    const content = [];
    earlier.forEach((img, i) => {
      content.push({ type: "text", text: `Earlier screenshot ${i + 1} of ${earlier.length}:` }, ClaudeAI.#image(img));
    });
    if (image) {
      if (earlier.length) content.push({ type: "text", text: "Screenshot on screen now:" });
      content.push(ClaudeAI.#image(image));
    }
    content.push({ type: "text", text: requestText });
    const out = await this.#call({
      system: [
        { type: "text", text: REPLY_SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: memory, cache_control: { type: "ephemeral" } },
      ],
      content,
      schema: REPLY_SCHEMA,
      model: plus ? this.plusModel : this.model,
      effort, // medium: reading who is asking whom for what needs real thinking, even for text-only prompts
    });
    return { context: out.context, read: out.read, replies: out.replies.slice(0, CANDIDATES) };
  }

  /**
   * Scores candidate replies 1-10 against the rubric in JUDGE_SYSTEM (misread, generic, invented facts, not the user...).
   * Returns [{ score, issue }] in the same order as `texts`.
   */
  async judgeReplies({ memory, requestText, read, texts, image, plus = false }) {
    const readLine = read ? `Rizzio's read: kind ${read.kind}; stage ${read.stage}; hook: ${read.hook}; play: ${read.play}; needs: ${read.needs}; their humor: ${read.her_humor || "unknown"}; what they want: ${read.her_wants || "unclear"}` : "";
    const content = [];
    if (image) content.push(ClaudeAI.#image(image));
    content.push({
      type: "text",
      text: [`What the user is replying to:\n${requestText}`, readLine, "Candidates:\n" + texts.map((t, i) => `${i + 1}. ${t}`).join("\n")].filter(Boolean).join("\n\n"),
    });
    const out = await this.#call({
      model: plus ? this.plusModel : this.model,
      system: [
        { type: "text", text: JUDGE_SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: memory, cache_control: { type: "ephemeral" } },
      ],
      content,
      schema: JUDGE_SCHEMA,
      effort: "low",
    });
    const byN = new Map(out.scores.map((s) => [s.n, s]));
    return texts.map((_, i) => {
      const s = byN.get(i + 1);
      return { score: s ? Math.max(1, Math.min(10, Math.round(s.score))) : 5, issue: s?.issue ?? "" };
    });
  }

  /** Rewrites a few replies so they no longer use the given phrases, keeping everything else. */
  async rewriteWithout({ memory, texts, phrases, plus = false }) {
    return this.rewriteTexts({
      memory,
      texts,
      plus,
      instruction: `Rewrite each of these messages so it doesn't use any of these phrases: ${phrases.map((p) => `"${p}"`).join(", ")}. Keep the same idea, length, voice and punctuation; change only what's needed.`,
    });
  }

  /** Rewrites a few replies following one instruction (e.g. "make each under 150 characters"), same order back. */
  async rewriteTexts({ memory, texts, instruction, plus = false }) {
    const out = await this.#call({
      model: plus ? this.plusModel : this.model,
      system: [
        { type: "text", text: REPLY_SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: memory, cache_control: { type: "ephemeral" } },
      ],
      content: [{
        type: "text",
        text: `${instruction} Return them in the same order.\n` + texts.map((t, i) => `${i + 1}. ${t}`).join("\n"),
      }],
      schema: { type: "object", properties: { texts: { type: "array", items: { type: "string" } } }, required: ["texts"], additionalProperties: false },
      effort: "low",
    });
    return out.texts;
  }

  /** Drafts the About you note from what the user's own messages say about them. */
  async suggestAbout({ evidence }) {
    const out = await this.#call({
      system: [{ type: "text", text: ABOUT_SYSTEM }],
      content: [{ type: "text", text: evidence }],
      schema: { type: "object", properties: { about: { type: "string" } }, required: ["about"], additionalProperties: false },
      effort: "low",
    });
    return out.about.trim();
  }

  async rebuildProfile({ evidence }) {
    const out = await this.#call({
      system: [{ type: "text", text: PROFILE_SYSTEM }],
      content: [{ type: "text", text: evidence }],
      schema: PROFILE_SCHEMA,
      effort: "medium",
    });
    return out.profile.trim();
  }

  /** Reads how the user really texts and proposes slider values. */
  async autoTune({ evidence }) {
    const out = await this.#call({
      system: [{ type: "text", text: AUTOTUNE_SYSTEM }],
      content: [{ type: "text", text: evidence }],
      schema: AUTOTUNE_SCHEMA,
      effort: "medium",
    });
    return {
      settings: out.settings
        .filter((s) => SLIDERS.some((d) => d.key === s.key))
        .map((s) => ({ key: s.key, value: Math.max(0, Math.min(100, Math.round(s.value))), reason: s.reason })),
      lowercase: out.lowercase,
    };
  }

  async extractUserMessages({ image }) {
    const out = await this.#call({
      system: [{ type: "text", text: EXTRACT_SYSTEM }],
      content: [ClaudeAI.#image(image), { type: "text", text: "List the messages the user sent." }],
      schema: EXTRACT_SCHEMA,
      effort: "low",
    });
    return out.messages.map((m) => m.trim()).filter(Boolean).slice(0, 40);
  }
}
