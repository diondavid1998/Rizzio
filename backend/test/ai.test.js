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

test("replies: the model reads the message first and labels each reply's form", async () => {
  const out = {
    read: { kind: "several_questions", questions: ["what do you do?", "dogs or cats?"], needs: "answer both, then ask back" },
    context: "Their two questions",
    replies: [{ text: "nurse by day, chaos by night. dogs, obviously. you?", form: "answer_and_ask", angle: "answer + ask" }],
  };
  const ai = new ClaudeAI({ apiKey: "x" });
  ai.client = fakeClient({ text: JSON.stringify(out) });
  const r = await ai.generateReplies({ memory: "m", requestText: "Task: chat" });
  assert.deepEqual(r.read.questions, ["what do you do?", "dogs or cats?"]);
  assert.equal(r.replies[0].form, "answer_and_ask");
  const req = ai.client.calls[0];
  const schema = req.output_config.format.schema;
  assert.deepEqual(Object.keys(schema.properties), ["read", "context", "replies"], "read comes first so it's decided before writing");
  assert.ok(schema.properties.replies.items.properties.form.enum.includes("comeback"));
  const system = req.system.map((b) => b.text).join("\n");
  assert.match(system, /rhetorical question/i);
  assert.match(system, /challenge, rebuttal or hot take/);
  assert.match(system, /at least 4 different forms/);
  assert.match(system, /At least one of the 5 is a question back to them/);
  assert.match(system, /comes from the user alone/);
  assert.match(system, /Never borrow their wording, tone or opinions/);
  assert.ok(schema.properties.read.required.includes("as_user"), "the model thinks as the user before writing");
  assert.ok(schema.properties.read.required.includes("side_topic"), "it spots prompts that invite taking a side");
});

test("profile screenshots: earlier screens come first, the current one last, with more effort", async () => {
  const out = { read: { person: "Maya, 27, nurse", hook: "geese prompt", kind: "profile_prompt", questions: [], needs: "x", as_user: "x" }, context: "c", replies: [] };
  const ai = new ClaudeAI({ apiKey: "x" });
  ai.client = fakeClient({ text: JSON.stringify(out) });
  const img = (d) => ({ data: d, mediaType: "image/jpeg" });
  const r = await ai.generateReplies({ memory: "m", requestText: "t", image: img("NOW"), earlier: [img("A"), img("B")] });
  assert.equal(r.read.person, "Maya, 27, nurse");
  const req = ai.client.calls[0];
  const blocks = req.messages[0].content;
  const images = blocks.filter((b) => b.type === "image").map((b) => b.source.data);
  assert.deepEqual(images, ["A", "B", "NOW"]);
  assert.ok(blocks.some((b) => b.type === "text" && /on screen now/.test(b.text)));
  assert.equal(req.output_config.effort, "medium");
  assert.deepEqual(req.output_config.format.schema.properties.read.required.slice(0, 2), ["person", "hook"]);
  await ai.generateReplies({ memory: "m", requestText: "text only" });
  assert.equal(ai.client.calls.at(-1).output_config.effort, "low");
});
