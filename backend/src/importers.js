// Reads exported chat data (WhatsApp, Instagram/Messenger, Telegram, Hinge, Tinder, CSV/JSON/TXT, zips of those)
// into { format, messages: [{ sender, text }] }. No AI involved: plain parsing, so it's free.
import { unzipSync, strFromU8 } from "fflate";

export const YOU = "You"; // sender name for exports that only contain your own messages (Hinge, Tinder)

const SKIP = [
  /<media omitted>/i, /\b(image|video|audio|sticker|gif|document) omitted\b/i, /this message was deleted/i,
  /messages and calls are end-to-end encrypted/i, /^null$/i, /^(liked|loved|laughed at|emphasized|disliked) /i,
  /reacted .* to your message/i, /^missed (voice|video) call/i, /^\s*https?:\/\/\S+\s*$/i, /changed (the|their) (subject|group|phone)/i,
];

/** Keeps real messages people typed: drops system lines, media placeholders, links and very long pastes. */
export function isUsefulMessage(text) {
  const t = text.trim();
  return t.length >= 2 && t.length <= 400 && !SKIP.some((re) => re.test(t));
}

/** Facebook/Instagram JSON stores UTF-8 as Latin-1 escapes ("Ã©" for "é"); undo that when it applies. */
function fixMetaEncoding(s) {
  if (!/[Â-ô][\u0080-¿]/.test(s)) return s;
  try {
    const fixed = Buffer.from(s, "latin1").toString("utf8");
    return fixed.includes("�") ? s : fixed;
  } catch {
    return s;
  }
}

// ---------- text formats ----------

// "12/31/23, 9:41 PM - Name: text"  or  "[12/31/23, 9:41:05 PM] Name: text"  (also 24h, dots, dashes)
const WHATSAPP = /^‎?\[?(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[APap]\.?[Mm]\.?)?)\]?\s*(?:-\s*)?([^:]{1,60}):\s?(.*)$/;

export function parseWhatsApp(text) {
  const messages = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[‎ ]/g, " ").trimEnd();
    const m = WHATSAPP.exec(line);
    if (m) messages.push({ sender: m[3].trim(), text: m[4] });
    else if (messages.length && line.trim()) messages[messages.length - 1].text += "\n" + line; // multi-line message
  }
  return messages;
}

/** "Name: message" per line, for simple text exports. */
export function parseNameColonLines(text) {
  const messages = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^:\n]{1,40}):\s+(.+)$/.exec(line.trim());
    if (m && !/^https?$/i.test(m[1])) messages.push({ sender: m[1].trim(), text: m[2] });
  }
  return messages;
}

/** Minimal CSV reader (quoted fields, commas, newlines inside quotes). */
export function parseCSVRows(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const SENDER_KEYS = ["sender_name", "sender", "from", "author", "name", "who", "speaker", "contact", "is_from_me", "direction", "type"];
const TEXT_KEYS = ["content", "text", "message", "body", "msg", "message_text"];

function pickKey(keys, candidates) {
  const lower = keys.map((k) => k.toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c);
    if (i >= 0) return keys[i];
  }
  return null;
}

/** "Is from me" style columns (iMessage exporters) → sender "You" / "Them". */
function senderFromFlag(value) {
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "outgoing", "sent", "me"].includes(v)) return YOU;
  if (["0", "false", "no", "incoming", "received"].includes(v)) return "Them";
  return null;
}

export function parseCSV(text) {
  const rows = parseCSVRows(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const textKey = pickKey(header, TEXT_KEYS);
  const senderKey = pickKey(header, SENDER_KEYS);
  if (!textKey) return [];
  const ti = header.indexOf(textKey);
  const si = senderKey ? header.indexOf(senderKey) : -1;
  return rows.slice(1).map((r) => {
    const rawSender = si >= 0 ? r[si] ?? "" : YOU;
    const sender = senderFromFlag(rawSender) ?? (rawSender.trim() || "Unknown");
    return { sender, text: r[ti] ?? "" };
  });
}

// ---------- JSON formats ----------

function telegramText(t) {
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  return "";
}

/** Recognizes known JSON exports; falls back to any array of {sender, text}-like objects. */
export function parseJSON(data) {
  // Instagram / Facebook Messenger: { participants, messages: [{ sender_name, content }] }
  if (Array.isArray(data?.messages) && data.messages.some((m) => "sender_name" in (m ?? {}))) {
    return {
      format: "instagram-messenger",
      messages: data.messages
        .filter((m) => typeof m?.content === "string")
        .map((m) => ({ sender: fixMetaEncoding(m.sender_name), text: fixMetaEncoding(m.content) })),
    };
  }
  // Telegram: { chats: { list: [{ messages }] } } or a single chat { messages: [{ from, text }] }
  const tgChats = data?.chats?.list ?? (Array.isArray(data?.messages) && data.messages.some((m) => "from" in (m ?? {})) ? [data] : null);
  if (tgChats) {
    return {
      format: "telegram",
      messages: tgChats.flatMap((c) =>
        (c.messages ?? []).filter((m) => m?.type !== "service" && m?.from).map((m) => ({ sender: m.from, text: telegramText(m.text) })),
      ),
    };
  }
  // Tinder "Download My Data": { Messages: [{ messages: [{ message }] }] } (only messages you sent)
  if (Array.isArray(data?.Messages)) {
    return {
      format: "tinder",
      messages: data.Messages.flatMap((t) => (t.messages ?? []).map((m) => ({ sender: YOU, text: String(m.message ?? "") }))),
    };
  }
  // Hinge "Download My Data" matches.json: [{ chats: [{ body }], like: [{ like: [{ comment }] }] }] (yours only)
  if (Array.isArray(data) && data.some((x) => Array.isArray(x?.chats) || Array.isArray(x?.like))) {
    const messages = [];
    for (const match of data) {
      for (const c of match.chats ?? []) if (typeof c?.body === "string") messages.push({ sender: YOU, text: c.body });
      for (const l of match.like ?? []) {
        for (const inner of l?.like ?? [l]) if (typeof inner?.comment === "string") messages.push({ sender: YOU, text: inner.comment });
      }
    }
    return { format: "hinge", messages };
  }
  // Generic: the largest array of objects that have a text-like key
  let best = [];
  const visit = (node, depth) => {
    if (depth > 6 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      const objs = node.filter((x) => x && typeof x === "object" && !Array.isArray(x));
      if (objs.length > best.length) {
        const keys = Object.keys(objs[0] ?? {});
        const tk = pickKey(keys, TEXT_KEYS);
        if (tk) {
          const sk = pickKey(keys, SENDER_KEYS);
          best = objs.map((o) => ({
            sender: sk ? senderFromFlag(o[sk]) ?? String(o[sk] ?? "Unknown") : YOU,
            text: typeof o[tk] === "string" ? o[tk] : "",
          }));
        }
      }
      node.forEach((x) => visit(x, depth + 1));
    } else Object.values(node).forEach((v) => visit(v, depth + 1));
  };
  visit(data, 0);
  return { format: "json", messages: best };
}

// ---------- dispatcher ----------

function parseTextFile(name, text) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) {
    try {
      return parseJSON(JSON.parse(text));
    } catch {
      return { format: "json", messages: [] };
    }
  }
  if (lower.endsWith(".csv")) return { format: "csv", messages: parseCSV(text) };
  const wa = parseWhatsApp(text);
  if (wa.length >= 2) return { format: "whatsapp", messages: wa };
  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
    try {
      return parseJSON(JSON.parse(text));
    } catch { /* not JSON */ }
  }
  return { format: "text", messages: parseNameColonLines(text) };
}

const TEXTY = /\.(json|txt|csv|text|log)$/i;

/** Parses one uploaded file (bytes). Zips are opened and every text/JSON/CSV inside is read; media is skipped. */
export function parseExport(name, bytes) {
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    let files;
    try {
      files = unzipSync(bytes, { filter: (f) => TEXTY.test(f.name) && !f.name.includes("__MACOSX") && f.originalSize < 50_000_000 });
    } catch {
      throw new Error("Couldn't open that zip file.");
    }
    const parts = Object.entries(files).map(([n, data]) => ({ name: n, ...parseTextFile(n, strFromU8(data)) }));
    const formats = [...new Set(parts.filter((p) => p.messages.length).map((p) => p.format))];
    return { format: formats.length ? `zip (${formats.join(", ")})` : "zip", messages: parts.flatMap((p) => p.messages) };
  }
  return parseTextFile(name, strFromU8(bytes));
}

/**
 * Groups messages by sender and guesses which one is you: "You" if the export says so,
 * otherwise whoever sent the most (the app lets you pick a different sender).
 */
export function summarizeSenders(messages, limitPerSender = 2000) {
  const bySender = new Map();
  for (const m of messages) {
    const sender = (m.sender ?? "").toString().trim() || "Unknown";
    const text = (m.text ?? "").toString().trim();
    if (!isUsefulMessage(text)) continue;
    if (!bySender.has(sender)) bySender.set(sender, []);
    bySender.get(sender).push(text);
  }
  const senders = [...bySender.entries()]
    .map(([name, texts]) => ({ name, count: texts.length, texts: texts.slice(-limitPerSender) }))
    .sort((a, b) => b.count - a.count);
  const guess = senders.find((s) => s.name === YOU)?.name ?? senders[0]?.name ?? null;
  return { senders, guess };
}
