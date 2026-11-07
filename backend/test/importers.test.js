import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { YOU, isUsefulMessage, parseExport, summarizeSenders } from "../src/importers.js";

const u8 = (s) => strToU8(s);
const senders = (r) => summarizeSenders(r.messages);

describe("export formats", () => {
  test("WhatsApp .txt (Android and iPhone styles, multi-line, system lines skipped)", () => {
    const android = [
      "12/31/23, 9:41 PM - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.",
      "12/31/23, 9:41 PM - Maya: so what do you do for fun",
      "12/31/23, 9:42 PM - Dion: lowkey just climbing lol",
      "and making pasta",
      "12/31/23, 9:43 PM - Dion: <Media omitted>",
      "12/31/23, 9:44 PM - Maya: that is elite",
    ].join("\n");
    const r = parseExport("WhatsApp Chat with Maya.txt", u8(android));
    assert.equal(r.format, "whatsapp");
    const s = senders(r);
    assert.deepEqual(s.senders.find((x) => x.name === "Dion").texts, ["lowkey just climbing lol\nand making pasta"]);

    const iphone = "[1/2/24, 10:05:11 AM] Dion: say less\n[1/2/24, 10:06:00 AM] Maya: ok\n[1/2/24, 10:07:00 AM] Dion: i got u";
    const r2 = parseExport("_chat.txt", u8(iphone));
    assert.deepEqual(senders(r2).senders.find((x) => x.name === "Dion").texts, ["say less", "i got u"]);
  });

  test("Instagram / Messenger JSON (fixes Meta's broken emoji/accents)", () => {
    const json = JSON.stringify({
      participants: [{ name: "Maya" }, { name: "Dion" }],
      messages: [
        { sender_name: "Dion", content: "cafÃ© then? ð\u009f\u0098\u0082" },
        { sender_name: "Maya", content: "Liked a message" },
        { sender_name: "Maya", content: "yes!!" },
        { sender_name: "Dion", photos: [{ uri: "x.jpg" }] },
      ],
    });
    const r = parseExport("message_1.json", u8(json));
    assert.equal(r.format, "instagram-messenger");
    assert.deepEqual(senders(r).senders.find((x) => x.name === "Dion").texts, ["café then? 😂"]);
    assert.equal(senders(r).senders.find((x) => x.name === "Maya").count, 1); // "Liked a message" skipped
  });

  test("Telegram result.json", () => {
    const json = JSON.stringify({
      chats: { list: [{ messages: [
        { type: "service", action: "create_group" },
        { type: "message", from: "Dion", text: "bet" },
        { type: "message", from: "Maya", text: [{ type: "bold", text: "wait" }, " really?"] },
      ] }] },
    });
    const s = senders(parseExport("result.json", u8(json)));
    assert.deepEqual(s.senders.map((x) => x.name).sort(), ["Dion", "Maya"]);
    assert.deepEqual(s.senders.find((x) => x.name === "Maya").texts, ["wait really?"]);
  });

  test("Hinge matches.json → all yours", () => {
    const json = JSON.stringify([
      { chats: [{ body: "ok but who hurt you, the geese?", timestamp: "x" }], like: [{ like: [{ comment: "this prompt is elite" }] }] },
      { match: [{}] },
    ]);
    const r = parseExport("matches.json", u8(json));
    assert.equal(r.format, "hinge");
    const s = senders(r);
    assert.equal(s.guess, YOU);
    assert.deepEqual(s.senders[0].texts, ["ok but who hurt you, the geese?", "this prompt is elite"]);
  });

  test("Tinder data.json → all yours", () => {
    const json = JSON.stringify({ Usage: {}, Messages: [{ match_id: "1", messages: [{ message: "hey trouble", to: 1 }] }] });
    const s = senders(parseExport("data.json", u8(json)));
    assert.equal(s.guess, YOU);
    assert.deepEqual(s.senders[0].texts, ["hey trouble"]);
  });

  test("CSV with sender column, and iMessage-style is_from_me column", () => {
    const csv = 'date,sender,message\n2024-01-01,Dion,"hey, you up?"\n2024-01-01,Maya,"maybe ""why"""\n';
    const s = senders(parseExport("chat.csv", u8(csv)));
    assert.deepEqual(s.senders.find((x) => x.name === "Maya").texts, ['maybe "why"']);
    const imsg = "is_from_me,text\n1,omw\n0,k\n1,say less\n";
    const s2 = senders(parseExport("messages.csv", u8(imsg)));
    assert.equal(s2.guess, YOU);
    assert.deepEqual(s2.senders.find((x) => x.name === YOU).texts, ["omw", "say less"]);
  });

  test("plain 'Name: message' text and generic JSON", () => {
    const s = senders(parseExport("notes.txt", u8("Dion: lowkey yes\nMaya: ok\nDion: say less\n")));
    assert.equal(s.guess, "Dion");
    const generic = JSON.stringify({ data: { thread: [{ author: "Dion", body: "nah ur wild" }, { author: "Maya", body: "lol" }] } });
    assert.deepEqual(senders(parseExport("x.json", u8(generic))).senders.find((x) => x.name === "Dion").texts, ["nah ur wild"]);
  });

  test("zip of an export: reads text/JSON inside, skips media", () => {
    const zip = zipSync({
      "your_instagram_activity/messages/inbox/maya_123/message_1.json": u8(JSON.stringify({ messages: [{ sender_name: "Dion", content: "say less" }] })),
      "your_instagram_activity/messages/inbox/maya_123/photos/1.jpg": new Uint8Array([0xff, 0xd8, 0xff]),
      "WhatsApp Chat.txt": u8("1/1/24, 9:00 PM - Dion: bet\n1/1/24, 9:01 PM - Maya: ok"),
    });
    const r = parseExport("export.zip", zip);
    assert.match(r.format, /zip/);
    assert.deepEqual(senders(r).senders.find((x) => x.name === "Dion").texts.sort(), ["bet", "say less"]);
  });

  test("filters junk", () => {
    assert.equal(isUsefulMessage("https://example.com/x"), false);
    assert.equal(isUsefulMessage("This message was deleted"), false);
    assert.equal(isUsefulMessage("k"), false);
    assert.equal(isUsefulMessage("ok"), true);
  });
});

describe("import endpoints", () => {
  let server, base, store;
  beforeEach(async () => {
    store = openDb(":memory:");
    const app = createApp({ store, ai: {}, appToken: "t", log: { error() {} } });
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((r) => server.close(r)));

  const headers = { authorization: "Bearer t", "x-rizzio-user": "importer-1234" };
  const preview = (name, bytes) =>
    fetch(`${base}/v1/learn/file/preview?name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: bytes,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const json = (method, path, body) =>
    fetch(base + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body && JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));

  test("preview → pick yourself → only your messages are learned, then paged", async () => {
    const chat = Array.from({ length: 60 }, (_, i) =>
      `1/1/24, 9:${String(i).padStart(2, "0")} PM - ${i % 2 ? "Maya" : "Dion"}: message number ${i}`).join("\n");
    const p = await preview("WhatsApp Chat.txt", u8(chat));
    assert.equal(p.status, 200);
    assert.equal(p.body.format, "whatsapp");
    assert.equal(p.body.total, 60);
    assert.deepEqual(p.body.senders.map((s) => s.name).sort(), ["Dion", "Maya"]);
    assert.equal(p.body.senders[0].samples.length, 3);

    const c = await json("POST", "/v1/learn/file/commit", { importId: p.body.importId, sender: "Dion" });
    assert.equal(c.status, 200);
    assert.equal(c.body.added, 30);

    const page1 = (await json("GET", "/v1/me/examples?limit=20")).body;
    assert.equal(page1.total, 30);
    assert.equal(page1.items.length, 20);
    assert.ok(page1.items.every((e) => /message number \d*[02468]$/.test(e.text)), "only Dion's (even) messages");
    const page2 = (await json("GET", "/v1/me/examples?limit=20&offset=20")).body;
    assert.equal(page2.items.length, 10);
    assert.equal((await json("GET", "/v1/me/examples?q=number 58")).body.total, 1);

    // /v1/me only returns a small sample now
    assert.ok((await json("GET", "/v1/me")).body.learnedExamples.length <= 30);
    // an import can't be committed twice
    assert.equal((await json("POST", "/v1/learn/file/commit", { importId: p.body.importId, sender: "Dion" })).status, 404);
  });

  test("clear errors for empty or unreadable files", async () => {
    assert.equal((await preview("x.txt", u8("just some notes"))).status, 422);
    assert.equal((await preview("x.zip", new Uint8Array([0x50, 0x4b, 1, 2, 3]))).status, 400);
  });
});
