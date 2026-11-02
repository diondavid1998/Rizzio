import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, buildUserText, type RizzRequest } from "./prompt";

export interface Env {
  ANTHROPIC_API_KEY: string;
  APP_TOKEN: string;
  RIZZIO_MODEL?: string;
}

const MAX_IMAGE_BASE64_CHARS = 7_000_000; // ~5 MB image
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    context: {
      type: "string",
      description: "One short line describing what you replied to (e.g. 'Prompt: My simple pleasures — iced coffee and thunderstorms').",
    },
    replies: {
      type: "array",
      description: "Exactly 5 replies, best first.",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "The message to send, exactly as it should be typed." },
          angle: { type: "string", description: "2-3 word label for the approach, e.g. 'playful tease'." },
        },
        required: ["text", "angle"],
        additionalProperties: false,
      },
    },
  },
  required: ["context", "replies"],
  additionalProperties: false,
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validate(body: unknown): RizzRequest | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  const b = body as Record<string, unknown>;
  const mode = b.mode;
  if (mode !== "prompt" && mode !== "chat" && mode !== "draft") return "mode must be prompt, chat or draft.";
  const req: RizzRequest = {
    mode,
    tone: typeof b.tone === "string" ? b.tone.slice(0, 40) : "witty",
    aboutMe: typeof b.aboutMe === "string" ? b.aboutMe.slice(0, 1500) : "",
    styleExamples: typeof b.styleExamples === "string" ? b.styleExamples.slice(0, 3000) : "",
    text: typeof b.text === "string" ? b.text.slice(0, 8000) : undefined,
    draft: typeof b.draft === "string" ? b.draft.slice(0, 2000) : undefined,
  };
  if (b.image && typeof b.image === "object") {
    const img = b.image as Record<string, unknown>;
    if (typeof img.data !== "string" || img.data.length > MAX_IMAGE_BASE64_CHARS) return "image.data missing or too large.";
    const mediaType = (typeof img.mediaType === "string" ? img.mediaType : "image/jpeg") as ImageType;
    if (!IMAGE_TYPES.includes(mediaType)) return "Unsupported image type.";
    req.image = { data: img.data, mediaType };
  }
  if (!req.image && !req.text && !req.draft) return "Send an image, text, or draft.";
  return req;
}

async function generate(env: Env, req: RizzRequest) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (req.image) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: req.image.mediaType, data: req.image.data },
    });
  }
  content.push({ type: "text", text: buildUserText(req) });

  const response = await client.beta.messages.create({
    model: env.RIZZIO_MODEL || "claude-opus-5-5",
    max_tokens: 8000,
    // If the model declines a request, the API retries it on a fallback model automatically.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low", // short creative replies: fast and cheap is the right trade-off
      format: { type: "json_schema", schema: REPLY_SCHEMA },
    },
    system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    return { error: "The AI declined this one. Try a different screenshot or tone.", status: 422 };
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return { error: "No reply generated.", status: 502 };
  }
  try {
    const parsed = JSON.parse(textBlock.text) as { context: string; replies: { text: string; angle: string }[] };
    return { data: { context: parsed.context, replies: parsed.replies.slice(0, 5) }, status: 200 };
  } catch {
    return { error: "Couldn't read the AI's answer. Try again.", status: 502 };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname !== "/v1/replies" || request.method !== "POST") return json({ error: "Not found" }, 404);

    const auth = request.headers.get("authorization") ?? "";
    if (!env.APP_TOKEN || auth !== `Bearer ${env.APP_TOKEN}`) return json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const req = validate(body);
    if (typeof req === "string") return json({ error: req }, 400);

    try {
      const result = await generate(env, req);
      return result.data ? json(result.data) : json({ error: result.error }, result.status);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) return json({ error: "Busy right now, try again in a few seconds." }, 429);
      if (err instanceof Anthropic.AuthenticationError) return json({ error: "Server API key is invalid." }, 500);
      if (err instanceof Anthropic.APIError) return json({ error: `AI error (${err.status}).` }, 502);
      return json({ error: "Unexpected server error." }, 500);
    }
  },
};
