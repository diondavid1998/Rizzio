import Anthropic from "@anthropic-ai/sdk";
import { EXTRACT_SYSTEM, PROFILE_SYSTEM, REPLY_SYSTEM } from "./prompts.js";

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    context: { type: "string", description: "One short line naming what you replied to." },
    replies: {
      type: "array",
      description: "Exactly 5 messages, best first.",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "The message exactly as it should be sent." },
          angle: { type: "string", description: "2-3 word label for the approach." },
        },
        required: ["text", "angle"],
        additionalProperties: false,
      },
    },
  },
  required: ["context", "replies"],
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
    this.model = model || "claude-opus-5-5";
  }

  async #call({ system, content, schema, effort }) {
    let response;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 8000,
        // If the model declines, the API retries on a fallback model automatically.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort, format: { type: "json_schema", schema } },
        system,
        messages: [{ role: "user", content }],
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new AIError("Busy right now, try again in a few seconds.", 429);
      if (err instanceof Anthropic.AuthenticationError) throw new AIError("The server's Claude API key is invalid.", 500);
      if (err instanceof Anthropic.APIError) throw new AIError(`AI error (${err.status}).`, 502);
      throw new AIError("Couldn't reach the AI.", 502);
    }
    if (response.stop_reason === "refusal") throw new AIError("The AI declined this one. Try a different screenshot or tone.", 422);
    const block = response.content.find((b) => b.type === "text");
    if (!block) throw new AIError("The AI returned nothing.", 502);
    try {
      return JSON.parse(block.text);
    } catch {
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
    return { context: out.context, replies: out.replies.slice(0, 5) };
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
