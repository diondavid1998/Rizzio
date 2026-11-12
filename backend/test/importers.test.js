import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { gzipSync, strToU8, zipSync } from "fflate";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { UNLABELED, YOU, isUsefulMessage, parseExport, sniff, summarizeSenders } from "../src/importers.js";

const u8 = (s) => strToU8(s);
const senders = (r) => summarizeSenders(r.messages);

describe("export formats", () => {
  test("WhatsApp .txt (Android and iPhone styles, multi-line, system lines skipped)", async () => {
    const android = [
      "12/31/23, 9:41 PM - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.",
      "12/31/23, 9:41 PM - Maya: so what do you do for fun",
      "12/31/23, 9:42 PM - Dion: lowkey just climbing lol",
      "and making pasta",
      "12/31/23, 9:43 PM - Dion: <Media omitted>",
      "12/31/23, 9:44 PM - Maya: that is elite",
    ].join("\n");
    const r = await parseExport("WhatsApp Chat with Maya.txt", u8(android));
    assert.equal(r.format, "whatsapp");
    const s = senders(r);
    assert.deepEqual(s.senders.find((x) => x.name === "Dion").texts, ["lowkey just climbing lol\nand making pasta"]);

    const iphone = "[1/2/24, 10:05:11 AM] Dion: say less\n[1/2/24, 10:06:00 AM] Maya: ok\n[1/2/24, 10:07:00 AM] Dion: i got u";
    const r2 = await parseExport("_chat.txt", u8(iphone));
    assert.deepEqual(senders(r2).senders.find((x) => x.name === "Dion").texts, ["say less", "i got u"]);
  });

  test("Instagram / Messenger JSON (fixes Meta's broken emoji/accents)", async () => {
    const json = JSON.stringify({
      participants: [{ name: "Maya" }, { name: "Dion" }],
      messages: [
        { sender_name: "Dion", content: "cafÃ© then? ð\u009f\u0098\u0082" },
        { sender_name: "Maya", content: "Liked a message" },
        { sender_name: "Maya", content: "yes!!" },
        { sender_name: "Dion", photos: [{ uri: "x.jpg" }] },
      ],
    });
    const r = await parseExport("message_1.json", u8(json));
    assert.equal(r.format, "instagram-messenger");
    assert.deepEqual(senders(r).senders.find((x) => x.name === "Dion").texts, ["café then? 😂"]);
    assert.equal(senders(r).senders.find((x) => x.name === "Maya").count, 1); // "Liked a message" skipped
  });

  test("Telegram result.json", async () => {
    const json = JSON.stringify({
      chats: { list: [{ messages: [
        { type: "service", action: "create_group" },
        { type: "message", from: "Dion", text: "bet" },
        { type: "message", from: "Maya", text: [{ type: "bold", text: "wait" }, " really?"] },
      ] }] },
    });
    const s = senders(await parseExport("result.json", u8(json)));
    assert.deepEqual(s.senders.map((x) => x.name).sort(), ["Dion", "Maya"]);
    assert.deepEqual(s.senders.find((x) => x.name === "Maya").texts, ["wait really?"]);
  });

  test("Hinge matches.json → all yours", async () => {
    const json = JSON.stringify([
      { chats: [{ body: "ok but who hurt you, the geese?", timestamp: "x" }], like: [{ like: [{ comment: "this prompt is elite" }] }] },
      { match: [{}] },
    ]);
    const r = await parseExport("matches.json", u8(json));
    assert.equal(r.format, "hinge");
    const s = senders(r);
    assert.equal(s.guess, YOU);
    assert.deepEqual(s.senders[0].texts, ["ok but who hurt you, the geese?", "this prompt is elite"]);
  });

  test("Tinder data.json → all yours", async () => {
    const json = JSON.stringify({ Usage: {}, Messages: [{ match_id: "1", messages: [{ message: "hey trouble", to: 1 }] }] });
    const s = senders(await parseExport("data.json", u8(json)));
    assert.equal(s.guess, YOU);
    assert.deepEqual(s.senders[0].texts, ["hey trouble"]);
  });

  test("CSV with sender column, and iMessage-style is_from_me column", async () => {
    const csv = 'date,sender,message\n2024-01-01,Dion,"hey, you up?"\n2024-01-01,Maya,"maybe ""why"""\n';
    const s = senders(await parseExport("chat.csv", u8(csv)));
    assert.deepEqual(s.senders.find((x) => x.name === "Maya").texts, ['maybe "why"']);
    const imsg = "is_from_me,text\n1,omw\n0,k\n1,say less\n";
    const s2 = senders(await parseExport("messages.csv", u8(imsg)));
    assert.equal(s2.guess, YOU);
    assert.deepEqual(s2.senders.find((x) => x.name === YOU).texts, ["omw", "say less"]);
  });

  test("plain 'Name: message' text and generic JSON", async () => {
    const s = senders(await parseExport("notes.txt", u8("Dion: lowkey yes\nMaya: ok\nDion: say less\n")));
    assert.equal(s.guess, "Dion");
    const generic = JSON.stringify({ data: { thread: [{ author: "Dion", body: "nah ur wild" }, { author: "Maya", body: "lol" }] } });
    assert.deepEqual(senders(await parseExport("x.json", u8(generic))).senders.find((x) => x.name === "Dion").texts, ["nah ur wild"]);
  });

  test("zip of an export: reads text/JSON inside, skips media", async () => {
    const zip = zipSync({
      "your_instagram_activity/messages/inbox/maya_123/message_1.json": u8(JSON.stringify({ messages: [{ sender_name: "Dion", content: "say less" }] })),
      "your_instagram_activity/messages/inbox/maya_123/photos/1.jpg": new Uint8Array([0xff, 0xd8, 0xff]),
      "WhatsApp Chat.txt": u8("1/1/24, 9:00 PM - Dion: bet\n1/1/24, 9:01 PM - Maya: ok"),
    });
    const r = await parseExport("export.zip", zip);
    assert.match(r.format, /zip/);
    assert.deepEqual(senders(r).senders.find((x) => x.name === "Dion").texts.sort(), ["bet", "say less"]);
  });

  test("binary files are rejected clearly, never shown as junk senders", async () => {
    const junk = new Uint8Array(4000).map((_, i) => (i * 7919) % 256);
    await assert.rejects(parseExport("weird.dat", junk), /can't read that file type/);
    await assert.rejects(parseExport("a.gz", new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2])), /\.gz/);
    await assert.rejects(parseExport("clip.mov", new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0])), /video or audio/);
    await assert.rejects(parseExport("photo.heic", new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0])), /photo/);
    assert.equal(sniff(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), "pdf");
  });

  test("PDF chat exports", async () => {
    const { readFileSync } = await import("node:fs");
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/chat.pdf", import.meta.url)));
    const r = await parseExport("Chat with Maya.pdf", bytes);
    assert.match(r.format, /^pdf/);
    assert.deepEqual(senders(r).senders.find((x) => x.name === "Dion").texts, ["lowkey just climbing lol", "say less, i got u"]);
  });

  test("UTF-16 text exports (some iMessage tools)", async () => {
    const text = "Dion: say less\nMaya: ok\nDion: bet\n";
    const bytes = new Uint8Array([0xff, 0xfe, ...Buffer.from(text, "utf16le")]);
    const s = senders(await parseExport("messages.txt", bytes));
    assert.deepEqual(s.senders.find((x) => x.name === "Dion").texts, ["say less", "bet"]);
  });

  const textsOf = async (name, bytes, who) => senders(await parseExport(name, bytes)).senders.find((x) => x.name === who)?.texts;

  test("iMessage chat.db, WhatsApp msgstore.db, Android SMS db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rz-test-"));
    try {
      const mk = (file, sql) => {
        const path = join(dir, file);
        const db = new DatabaseSync(path);
        db.exec(sql);
        db.close();
        return new Uint8Array(readFileSync(path));
      };
      const chatdb = mk("chat.db", `CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, is_from_me INTEGER, handle_id INTEGER, date INTEGER);
        INSERT INTO handle VALUES (1, '+15551234');
        INSERT INTO message VALUES (1, 'u up?', NULL, 0, 1, 1), (2, 'maybe lol', NULL, 1, 1, 2), (3, 'say less', NULL, 1, 1, 3);`);
      assert.equal(sniff(chatdb), "sqlite");
      const r = await parseExport("chat.db", chatdb);
      assert.equal(r.format, "imessage");
      assert.equal(senders(r).guess, YOU);
      assert.deepEqual(senders(r).senders.find((x) => x.name === YOU).texts, ["maybe lol", "say less"]);

      const wa = mk("msgstore.db", `CREATE TABLE message (_id INTEGER PRIMARY KEY, from_me INTEGER, text_data TEXT, timestamp INTEGER);
        INSERT INTO message VALUES (1, 1, 'bet', 1), (2, 0, 'ok', 2);`);
      assert.deepEqual(await textsOf("msgstore.db", wa, YOU), ["bet"]);

      const sms = mk("mmssms.db", `CREATE TABLE sms (_id INTEGER PRIMARY KEY, type INTEGER, address TEXT, body TEXT, date INTEGER);
        INSERT INTO sms VALUES (1, 2, '555', 'omw now', 1), (2, 1, '555', 'kk', 2);`);
      assert.deepEqual(await textsOf("mmssms.db", sms, YOU), ["omw now"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SMS Backup & Restore XML", async () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><smses count="3">
      <sms address="555" body="you free friday?" type="1" contact_name="Maya" />
      <sms address="555" body="for you? always &amp; forever" type="2" contact_name="Maya" />
      <mms msg_box="2" address="555"><parts><part ct="text/plain" text="lol bet" /></parts></mms></smses>`;
    const r = await parseExport("sms-20240101.xml", u8(xml));
    assert.equal(r.format, "sms-backup-xml");
    assert.deepEqual(senders(r).senders.find((x) => x.name === YOU).texts, ["for you? always & forever", "lol bet"]);
  });

  test("Instagram/Facebook HTML download, and plain HTML pages", async () => {
    const html = `<html><body>
      <div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_3-95 _2pim _a6-h _a6-i">Dion</div><div class="_3-95 _a6-p"><div><div></div><div>say less</div></div></div><div class="_3-94 _a6-o">Jan 1</div></div>
      <div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_3-95 _2pim _a6-h _a6-i">Maya</div><div class="_3-95 _a6-p"><div>ok cool</div></div><div class="_3-94 _a6-o">Jan 1</div></div>
      </body></html>`;
    const r = await parseExport("message_1.html", u8(html));
    assert.equal(r.format, "instagram-messenger-html");
    assert.deepEqual(senders(r).senders.find((x) => x.name === "Dion").texts, ["say less"]);
    assert.deepEqual(await textsOf("chat.html", u8("<html><p>Dion: nah ur wild</p><p>Maya: lol</p><p>Dion: bet</p></html>"), "Dion"), ["nah ur wild", "bet"]);
  });

  test("Word, Excel and OpenOffice documents", async () => {
    const docx = zipSync({
      "[Content_Types].xml": u8("<Types/>"),
      "word/document.xml": u8('<w:document><w:body><w:p><w:r><w:t>Dion: lowkey yes</w:t></w:r></w:p><w:p><w:r><w:t>Maya: ok</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Dion: say less</w:t></w:r></w:p></w:body></w:document>'),
    });
    assert.deepEqual(await textsOf("chat.docx", docx, "Dion"), ["lowkey yes", "say less"]);

    const xlsx = zipSync({
      "xl/workbook.xml": u8("<workbook/>"),
      "xl/sharedStrings.xml": u8("<sst><si><t>Sender</t></si><si><t>Message</t></si><si><t>Dion</t></si><si><t>hey trouble</t></si><si><t>Maya</t></si><si><t>hi</t></si></sst>"),
      "xl/worksheets/sheet1.xml": u8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row><row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" t="s"><v>5</v></c></row></sheetData></worksheet>'),
    });
    const x = await parseExport("chat.xlsx", xlsx);
    assert.equal(x.format, "xlsx");
    assert.deepEqual(senders(x).senders.find((s) => s.name === "Dion").texts, ["hey trouble"]);

    const odt = zipSync({ mimetype: u8("application/vnd.oasis.opendocument.text"), "content.xml": u8("<office:text><text:p>Dion: bet</text:p><text:p>Maya: ok</text:p><text:p>Dion: say less</text:p></office:text>") });
    assert.deepEqual(await textsOf("chat.odt", odt, "Dion"), ["bet", "say less"]);
  });

  test("RTF, TSV, JSONL, Markdown and email (eml/mbox)", async () => {
    const rtf = String.raw`{\rtf1\ansi{\fonttbl\f0 Helvetica;}\f0 Dion: caf\'e9 then?\par Maya: yes\par Dion: say less\par}`;
    assert.deepEqual(await textsOf("chat.rtf", u8(rtf), "Dion"), ["café then?", "say less"]);

    assert.deepEqual(await textsOf("chat.tsv", u8("from\ttext\nDion\tnah ur wild\nMaya\tlol\n"), "Dion"), ["nah ur wild"]);

    const jsonl = '{"author":"Dion","text":"bet"}\n{"author":"Maya","text":"ok"}\n{"author":"Dion","text":"omw"}\n';
    assert.deepEqual(await textsOf("chat.jsonl", u8(jsonl), "Dion"), ["bet", "omw"]);

    assert.deepEqual(await textsOf("notes.md", u8("# chat\n\n**Dion**: hi\nDion: hey you\nMaya: hi\n"), "Dion"), ["hey you"]);

    const mbox = [
      "From dion@x.com Mon Jan 1 00:00:00 2024",
      "From: Dion David <dion@x.com>", "To: maya@x.com", "Subject: hi", "", "dinner friday? my treat", "",
      "On Sun, Maya wrote:", "> maybe",
      "From maya@x.com Mon Jan 1 00:00:00 2024",
      "From: Maya <maya@x.com>", "Subject: re", "", "sounds fun", "",
    ].join("\n");
    const m = await parseExport("inbox.mbox", u8(mbox));
    assert.equal(m.format, "email");
    assert.deepEqual(senders(m).senders.find((x) => x.name === "Dion David").texts, ["dinner friday? my treat"]);
  });

  test("tar, tar.gz and .gz archives, nested zips", async () => {
    const tarOf = (files) => {
      const blocks = [];
      for (const [name, data] of Object.entries(files)) {
        const h = new Uint8Array(512);
        h.set(u8(name), 0);
        h.set(u8("0000644\0"), 100);
        h.set(u8(data.length.toString(8).padStart(11, "0") + "\0"), 124);
        h[156] = 48;
        h.set(u8("ustar\0"), 257);
        blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
      }
      blocks.push(new Uint8Array(1024));
      return Buffer.concat(blocks);
    };
    const chat = u8("1/1/24, 9:00 PM - Dion: bet\n1/1/24, 9:01 PM - Maya: ok");
    const tar = new Uint8Array(tarOf({ "export/chat.txt": chat, "export/pic.jpg": new Uint8Array([0xff, 0xd8, 0xff]) }));
    assert.equal(sniff(tar), "tar");
    assert.deepEqual(await textsOf("export.tar", tar, "Dion"), ["bet"]);
    assert.deepEqual(await textsOf("export.tar.gz", gzipSync(tar), "Dion"), ["bet"]);
    assert.deepEqual(await textsOf("chat.txt.gz", gzipSync(chat), "Dion"), ["bet"]);
    const nested = zipSync({ "inner.zip": zipSync({ "a/message_1.json": u8(JSON.stringify({ messages: [{ sender_name: "Dion", content: "say less" }] })) }) });
    assert.deepEqual(await textsOf("outer.zip", nested, "Dion"), ["say less"]);
  });

  test("text with no names becomes 'unlabeled lines' (the app asks before learning them)", async () => {
    const r = await parseExport("my texts.txt", u8("lowkey yes\nsay less\nnah ur wild\n"));
    assert.deepEqual(senders(r).senders.map((x) => x.name), [UNLABELED]);
    assert.ok(UNLABELED.length <= 60);
  });

  test("Snapchat chat_history.json (both layouts); snap_history and My AI give clear errors", async () => {
    const old = JSON.stringify({
      "Received Saved Chat History": [{ From: "friend_a", "Media Type": "TEXT", Created: "2024-01-01 10:00:00 UTC", Text: "did you see the game" }],
      "Sent Saved Chat History": [
        { To: "friend_a", "Media Type": "TEXT", Created: "2024-01-01 10:01:00 UTC", Text: "nahh what happened" },
        { To: "friend_a", "Media Type": "MEDIA", Created: "2024-01-01 10:02:00 UTC", Text: "" },
      ],
      "Sent Unsaved Chat History": [{ To: "friend_a", "Media Type": "TEXT", Created: "2024-01-01 10:03:00 UTC", Text: "ok tell me everything" }],
    });
    const r = await parseExport("chat_history.json", u8(old));
    assert.equal(r.format, "snapchat");
    const s = senders(r);
    assert.equal(s.guess, YOU);
    assert.deepEqual(s.senders.find((x) => x.name === YOU).texts.sort(), ["nahh what happened", "ok tell me everything"]);
    assert.deepEqual(s.senders.find((x) => x.name === "friend_a").texts, ["did you see the game"]);

    const fresh = JSON.stringify({ friend_b: [
      { From: "friend_b", "Media Type": "TEXT", Created: "x", Content: "ok but why", IsSender: false },
      { From: "me", "Media Type": "TEXT", Created: "x", Content: "because i said so lol", IsSender: true },
    ] });
    assert.deepEqual(senders(await parseExport("chat_history.json", u8(fresh))).senders.find((x) => x.name === YOU).texts, ["because i said so lol"]);

    await assert.rejects(parseExport("snap_history.json", u8(JSON.stringify({ "Received Snap History": [{ From: "a", "Media Type": "IMAGE", Created: "x" }], "Sent Snap History": [] }))), /only lists photos and videos/);
    await assert.rejects(parseExport("snapchat_ai.json", u8(JSON.stringify({ "": [{ Date: "x", Type: "CHAT", Message: "Hey! What's up?" }] }))), /My AI/);
  });

  test("filters junk", async () => {
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
    const junk = await preview("x.pdf.bin", new Uint8Array(3000).map((_, i) => (i * 131) % 256));
    assert.equal(junk.status, 400);
    assert.match(junk.body.error, /can't read that file type/);
    assert.equal((await preview("x.zip", new Uint8Array([0x50, 0x4b, 1, 2, 3]))).status, 400);
  });
});
