import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeAI } from "../src/ai.js";

const badRequest = (msg) => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: msg } }, msg, new Headers());

function fakeClient({ rejectBeta = false, rejectFormat = false, text }) {
  const calls = [];
  const create = async (req) => {
    calls.push(req);
    if (rejectFormat && req.output_config?.format) throw badRequest("output_config.format: not supported");
    return { stop_reason: "end_turn", content: [{ type: "text", text }] };
  };
  return {
    calls,
    messages: { create },
    beta: {
      messages: {
        create: async (req) => {
          calls.push(req);
          if (rejectBeta) throw badRequest("fallbacks: unknown parameter");
          return create(req);
        },
      },
    },
  };
}

test("falls back to simpler requests when Claude rejects newer features, and remembers", async () => {
  const ai = new ClaudeAI({ apiKey: "x" });
  ai.client = fakeClient({ rejectBeta: true, rejectFormat: true, text: 'Sure!\n```json\n{"profile":"short, lowercase"}\n```' });
  const origError = console.error; const origWarn = console.warn; console.error = () => {}; console.warn = () => {};
  try {
    assert.equal(await ai.rebuildProfile({ evidence: "x" }), "short, lowercase");
    assert.equal(ai.workingVariant, "plain-json");
    assert.equal(ai.client.calls.length, 3);
    await ai.rebuildProfile({ evidence: "y" });
    assert.equal(ai.client.calls.length, 4, "second call should go straight to the working shape");
  } finally {
    console.error = origError; console.warn = origWarn;
  }
});

test("reports Claude's actual reason when every shape is rejected", async () => {
  const ai = new ClaudeAI({ apiKey: "x" });
  const c = fakeClient({ text: "" });
  c.messages.create = async () => { throw badRequest("model: claude-nope is not a valid model"); };
  c.beta.messages.create = c.messages.create;
  ai.client = c;
  const origError = console.error; console.error = () => {};
  try {
    await assert.rejects(ai.rebuildProfile({ evidence: "x" }), /AI error \(400\): .*not a valid model/);
  } finally {
    console.error = origError;
  }
});

test("explains an empty Claude balance in plain English", async () => {
  const ai = new ClaudeAI({ apiKey: "x" });
  const c = fakeClient({ text: "" });
  c.beta.messages.create = async () => { throw badRequest("Your credit balance is too low to access the Anthropic API."); };
  ai.client = c;
  await assert.rejects(ai.rebuildProfile({ evidence: "x" }), /out of credits/);
});
