import Anthropic from "@anthropic-ai/sdk";
import { SLIDERS } from "./persona.js";
import { AUTOTUNE_SYSTEM, EXTRACT_SYSTEM, PROFILE_SYSTEM, REPLY_SYSTEM } from "./prompts.js";

/** How a reply responds to what was said. The model picks one per reply and must use at least 4 different ones. */
export const REPLY_FORMS = [
  "answer", "answer_and_ask", "play_along", "comeback", "tease_back", "agree_and_raise", "playful_disagree",
  "bold_guess", "follow_up_question", "callback", "story", "compliment_back", "make_plans", "hook",
];
export const MESSAGE_KINDS = [
  "profile_prompt", "photo", "question", "several_questions", "rhetorical_question", "challenge_or_hot_take",
  "tease", "story_or_statement", "compliment", "making_plans", "low_effort", "mixed",
];

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    read: {
      type: "object",
      description: "Fill this in first: what they sent and what a good reply has to do.",
      properties: {
        kind: { type: "string", enum: MESSAGE_KINDS },
        questions: { type: "array", items: { type: "string" }, description: "Every question they asked that needs an answer (empty if none)." },
        needs: { type: "string", description: "One line: what a good reply has to do here." },
      },
      required: ["kind", "questions", "needs"],
      additionalProperties: false,
    },
    context: { type: "string", description: "One short line naming what you replied to." },
    replies: {
      type: "array",
      description: "Exactly 5 messages, best first.",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "The message exactly as it should be sent." },
          form: { type: "string", enum: REPLY_FORMS, description: "How this reply responds to what was said." },
          angle: { type: "string", description: "2-4 word label for the approach, shown to the user." },
        },
        required: ["text", "form", "angle"],
        additionalProperties: false,
      },
    },
  },
  required: ["read", "context", "replies"],
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
  constructor({ apiKey, model }) {
    this.client = new Anthropic({ apiKey });
    // Premium = Claude Haiku: fast and cheap. Set RIZZIO_MODEL to use another model.
    this.model = model || "claude-haiku-5-5";
  }

  /**
   * Request shapes to try, newest features first. If Claude's API rejects one with a 400
   * (e.g. a beta this account or model doesn't have), the next, simpler shape is used,
   * and the one that works is remembered so later calls go straight to it.
   */
  static VARIANTS = ["full", "no-fallback", "plain-json"];

  #request(variant, { system, content, schema, effort }) {
    const base = { model: this.model, max_tokens: 8000, system, messages: [{ role: "user", content }] };
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
    const start = ClaudeAI.VARIANTS.indexOf(this.workingVariant ?? "full");
    let response;
    let lastBadRequest = null;
    for (const variant of ClaudeAI.VARIANTS.slice(start)) {
      try {
        response = await this.#request(variant, args);
        if (this.workingVariant !== variant) {
          if (lastBadRequest) console.warn(`Claude request works with variant "${variant}"; using it from now on.`);
          this.workingVariant = variant;
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
        if (err instanceof Anthropic.NotFoundError) throw new AIError(`Claude model "${this.model}" wasn't found. Check RIZZIO_MODEL.`, 500);
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
  async generateReplies({ memory, requestText, image }) {
    const content = [];
    if (image) content.push(ClaudeAI.#image(image));
    content.push({ type: "text", text: requestText });
    const out = await this.#call({
      system: [
        { type: "text", text: REPLY_SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: memory, cache_control: { type: "ephemeral" } },
      ],
      content,
      schema: REPLY_SCHEMA,
      effort: "low", // short creative replies: speed matters more than deep reasoning
    });
    return { context: out.context, read: out.read, replies: out.replies.slice(0, 5) };
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
