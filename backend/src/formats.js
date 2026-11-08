// Readers for the less common export formats: HTML, XML (SMS backups), Word/Excel/OpenOffice, RTF,
// email (EML/MBOX), SQLite databases (iMessage chat.db, WhatsApp, Android SMS), and tar archives.
// Each returns [{ sender, text }]. No AI: plain parsing.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8 } from "fflate";

export const YOU = "You";

// ---------- markup → text ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Turns HTML/XML into plain text with one line per block. */
export function markupToText(markup) {
  return decodeEntities(
    markup
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|\/w:p|\/text:p|\/a:p)\b[^>]*>/gi, "\n")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Instagram / Facebook "HTML" downloads: each message is a sender <div> followed by a content <div>.
 * (Class names differ by year; these cover the known layouts.)
 */
export function parseMetaHTML(html) {
  const messages = [];
  const re = /<div class="[^"]*(?:_a6-h|_2pim|_2lek)[^"]*">([\s\S]*?)<\/div>\s*<div class="[^"]*(?:_a6-p|_2let)[^"]*">([\s\S]*?)<\/div>\s*<div class="[^"]*(?:_a6-o|_2lem|_3-94)/g;
  for (const m of html.matchAll(re)) {
    messages.push({ sender: markupToText(m[1]), text: markupToText(m[2]) });
  }
  return messages;
}

// ---------- XML: "SMS Backup & Restore" (Android) ----------

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = decodeEntities(m[2]);
  return out;
}

export function parseSmsBackupXML(xml) {
  const messages = [];
  for (const m of xml.matchAll(/<sms\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (!a.body) continue;
    messages.push({ sender: a.type === "2" ? YOU : a.contact_name || a.address || "Them", text: a.body });
  }
  for (const m of xml.matchAll(/<mms\b([^>]*)>([\s\S]*?)<\/mms>/g)) {
    const a = attrs(`<mms ${m[1]}>`);
    for (const p of m[2].matchAll(/<part\b[^>]*>/g)) {
      const pa = attrs(p[0]);
      if (pa.ct === "text/plain" && pa.text && pa.text !== "null") {
        messages.push({ sender: a.msg_box === "2" ? YOU : a.contact_name || a.address || "Them", text: pa.text });
      }
    }
  }
  return messages;
}

// ---------- Office files (they're zips of XML) ----------

export function docxText(files) {
  const xml = files["word/document.xml"];
  return xml ? markupToText(strFromU8(xml)) : "";
}

export function odtText(files) {
  const xml = files["content.xml"];
  return xml ? markupToText(strFromU8(xml)) : "";
}

/** Excel → rows of cell text (first sheet), so it can be read like a CSV. */
export function xlsxRows(files) {
  const shared = files["xl/sharedStrings.xml"]
    ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        decodeEntities([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
      )
    : [];
  const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) return [];
  const rows = [];
  for (const row of strFromU8(files[sheetName]).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+)\d+"/.exec(c[1])?.[1];
      const col = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
      const type = /t="(\w+)"/.exec(c[1])?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? "")?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2] ?? "")?.[1] ?? "";
      cells[col] = type === "s" ? shared[Number(v)] ?? "" : decodeEntities(v);
    }
    rows.push(Array.from(cells, (x) => x ?? ""));
  }
  return rows;
}

// ---------- RTF ----------

export function rtfToText(rtf) {
  return rtf
    .replace(/\{\\\*[^{}]*\}/g, "")
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info|expandedcolortbl)(?:[^{}]|\{[^{}]*\})*\}/g, "")
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\\(par|line)\b ?/g, "\n")
    .replace(/\\\r?\n/g, "\n") // TextEdit's line breaks
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

// ---------- Email: .eml / .mbox ----------

function emailBody(raw) {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  let body = rest.join("\n\n");
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(head)?.[1];
  if (boundary) {
    const parts = body.split("--" + boundary);
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p));
    body = plain ? plain.split(/\r?\n\r?\n/).slice(1).join("\n\n") : markupToText(parts.find((p) => /text\/html/i.test(p)) ?? "");
  } else if (/content-type:\s*text\/html/i.test(head)) body = markupToText(body);
  if (/content-transfer-encoding:\s*base64/i.test(raw) && /^[A-Za-z0-9+/=\s]+$/.test(body.trim())) {
    body = Buffer.from(body, "base64").toString("utf8");
  }
  // Keep only what this person wrote: drop quoted replies and signatures.
  const cut = body.search(/^(On .+wrote:|-----Original Message-----|-- ?$)/m);
  return (cut >= 0 ? body.slice(0, cut) : body)
    .split(/\r?\n/)
    .filter((l) => !l.startsWith(">"))
    .join("\n")
    .trim();
}

export function parseEmails(text) {
  const chunks = /^From .+$/m.test(text) ? text.split(/^From .+$/m).filter((c) => c.trim()) : [text];
  const messages = [];
  for (const raw of chunks) {
    const head = raw.split(/\r?\n\r?\n/)[0];
    const from = /^From:\s*(.+)$/im.exec(head)?.[1]?.trim();
    if (!from) continue;
    const name = /^"?([^"<]+?)"?\s*<.+>$/.exec(from)?.[1]?.trim() || from.replace(/[<>]/g, "");
    const body = emailBody(raw);
    if (body) messages.push({ sender: name, text: body.slice(0, 2000) });
  }
  return messages;
}

// ---------- SQLite: iMessage chat.db, WhatsApp msgstore.db, Android mmssms.db ----------

/** iOS 16+ stores many iMessage texts only in attributedBody (an archived NSAttributedString). Pull the string out. */
function attributedBodyText(blob) {
  if (!blob) return null;
  const b = Buffer.from(blob);
  const i = b.indexOf("NSString");
  if (i < 0) return null;
  let p = i + "NSString".length + 5; // skip class marker bytes
  let len = b[p];
  if (len === 0x81) { len = b.readUInt16LE(p + 1); p += 3; } else p += 1;
  return b.subarray(p, p + len).toString("utf8");
}

export function parseSQLite(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "rizzio-import-"));
  const file = join(dir, "upload.db");
  writeFileSync(file, bytes);
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    const cols = (t) => new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name));

    // iMessage (Mac ~/Library/Messages/chat.db)
    if (tables.has("message") && cols("message").has("is_from_me")) {
      const hasHandle = tables.has("handle");
      const rows = db
        .prepare(`SELECT m.text, m.attributedBody, m.is_from_me${hasHandle ? ", h.id AS who" : ""}
                  FROM message m ${hasHandle ? "LEFT JOIN handle h ON h.ROWID = m.handle_id" : ""}
                  ORDER BY m.date`)
        .all();
      return {
        format: "imessage",
        messages: rows.map((r) => ({
          sender: r.is_from_me ? YOU : r.who || "Them",
          text: r.text || attributedBodyText(r.attributedBody) || "",
        })),
      };
    }
    // WhatsApp Android, new schema
    if (tables.has("message") && cols("message").has("from_me") && cols("message").has("text_data")) {
      const rows = db.prepare("SELECT from_me, text_data FROM message ORDER BY timestamp").all();
      return { format: "whatsapp-db", messages: rows.map((r) => ({ sender: r.from_me ? YOU : "Them", text: r.text_data ?? "" })) };
    }
    // WhatsApp Android, old schema
    if (tables.has("messages") && cols("messages").has("key_from_me")) {
      const rows = db.prepare("SELECT key_from_me, data FROM messages ORDER BY timestamp").all();
      return { format: "whatsapp-db", messages: rows.map((r) => ({ sender: r.key_from_me ? YOU : "Them", text: r.data ?? "" })) };
    }
    // Android SMS (mmssms.db): type 2 = sent
    if (tables.has("sms") && cols("sms").has("body")) {
      const rows = db.prepare("SELECT type, address, body FROM sms ORDER BY date").all();
      return { format: "android-sms-db", messages: rows.map((r) => ({ sender: r.type === 2 ? YOU : r.address || "Them", text: r.body ?? "" })) };
    }
    // Anything else: the biggest table with a text-like column.
    let best = { format: "sqlite", messages: [] };
    for (const t of tables) {
      const c = [...cols(t)];
      const textCol = c.find((x) => /^(text|body|message|content|msg|data|text_data)$/i.test(x));
      if (!textCol) continue;
      const senderCol = c.find((x) => /^(is_from_me|from_me|key_from_me|sender|sender_name|from|author|type)$/i.test(x));
      const rows = db.prepare(`SELECT "${textCol}" AS text${senderCol ? `, "${senderCol}" AS who` : ""} FROM "${t}" LIMIT 200000`).all();
      if (rows.length > best.messages.length) {
        best = {
          format: "sqlite",
          messages: rows.map((r) => ({
            sender: senderCol ? (/from_me/i.test(senderCol) ? (r.who ? YOU : "Them") : String(r.who ?? "Unknown")) : YOU,
            text: typeof r.text === "string" ? r.text : "",
          })),
        };
      }
    }
    return best;
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- tar ----------

/** Files inside a .tar (name → bytes). */
export function untar(bytes) {
  const files = {};
  let off = 0;
  while (off + 512 <= bytes.length) {
    const header = bytes.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = strFromU8(header.subarray(0, 100)).replace(/\0.*$/s, "");
    const prefix = strFromU8(header.subarray(345, 500)).replace(/\0.*$/s, "");
    const size = parseInt(strFromU8(header.subarray(124, 136)).replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    off += 512;
    if (type === "0" || type === "\0") files[prefix ? `${prefix}/${name}` : name] = bytes.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}
