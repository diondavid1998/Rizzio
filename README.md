# Rizzio

AI reply suggestions for Hinge prompts and any text conversation, without leaving the app you're in.

**How it works**

1. On a Hinge profile, **press the Action Button** (iPhone 15 Pro / 16 and newer) or **double-tap the back of your iPhone** (Back Tap).
2. A Shortcut takes a screenshot and sends it to Rizzio in the background. Rizzio doesn't open.
3. If the prompt invites a side (a hot take, a this-or-that), Rizzio asks which side first. A few seconds later your 5 replies appear numbered 1-5, then a list to tap one and copy it, ready to paste.
4. Tap the comment box, switch to the **Rizzio keyboard**, and tap a reply to insert it.

**Scroll and tap again:** Hinge profiles are longer than one screen. Back Tap screenshots taken within 3 minutes of each other count as the same profile (up to 4 screens), so Rizzio reads the whole person: name, job, every prompt and photo. Before writing it notes who they are and which prompt or photo it is replying to.

The keyboard can also:
- **Chat with Rizzio** (speech-bubble button): quick asks like Shorter, Funnier, Bolder, Ask them out, Other prompt, Use their photo, More like me, or type any request in the text box ("make it about her dog", "use the second prompt") and tap **Ask**. Requests stack, so "shorter" then "about the dog" means both.
- **Pick a side**: when a prompt invites one (a hot take, a debate, a this-or-that), the keyboard shows **For <topic> · Against <topic> · Neutral · Both** (Both splits the 5 between the two sides). Tap one and the replies follow it, in your voice. Tap it again to let Rizzio decide.
- **Length meter** (Auto · Phrase · Short · Medium · Long): how long replies are, from a 1-5 word reaction to a 25-50 word answer. Auto follows the Length slider in Persona. Each reply shows its word count, and the choice also applies to the next Back Tap.
- **Switch tone** with one tap (Me, Witty, Humor, Question, Flirty, Chill, Bold, Sweet, Corny; Question makes all 5 a specific question about them): the replies are rewritten in that tone right away.
- **Clipboard**: copy a profile prompt or someone's message, tap Clipboard, and get 5 replies (works in iMessage, Instagram, anything). Rizzio works out whether it's a prompt or a message, and uses your Back Tap screenshots from the last 10 minutes to know who the person is.
- **Polish**: type a rough draft and get 5 better versions.
- **↻**: 5 fresh replies for the same screenshot or text.

## Free or Premium

Setup → **AI** switches the engine for everything (Action Button, keyboard, Train, Persona):

- **Free:** Apple Intelligence on the iPhone (iOS 26+, Apple Intelligence on). Screenshots are read on the phone and replies are written by Apple's on-device model. Costs nothing, works offline; the server only stores history and learned messages. Replies are simpler.
- **Premium:** Claude Haiku on your Rizzio server (`RIZZIO_MODEL` overrides the model). Wittier, closer to your style. Uses Claude API credits.

## The app is the control room

The everyday flow is the Action Button and the keyboard. The app is where you shape how Rizzio sounds:

- **Persona**: 12 sliders (Flirty, Humor, Boldness, Warmth, Spice, Humor style, Teasing, Length, Emoji, Polish, Questions, Pace), presets (Smooth, Golden retriever, Dry wit, Hopeless romantic, Chaos, Chill), a **Scan photos** switch (off = only their written prompts and messages) and an **Emoji in replies** on/off switch (also a one-tap button on the keyboard; when off, emoji are removed from every reply), rules like "all lowercase" and "no pickup lines", a goal (match, keep it going, number, date, friends), a "never mention" list, and a **Test drive** to see sample replies before saving. **Match how I actually text** sets the sliders from how you really text.
- **Train → About you**: a few facts Rizzio can use (job, city, hobbies). **Fill in from what Rizzio knows** drafts it from your own messages; edit it, then Save.
- **Train**: upload chat screenshots from Photos, or import almost any file from Files (up to 100 MB): WhatsApp (.txt/.zip/msgstore.db), iMessage chat.db, Instagram/Messenger (JSON or HTML), Telegram result.json, Snapchat chat_history.json, SMS Backup & Restore XML, Android SMS databases, Hinge/Tinder "Download my data", PDF, Word (.docx), Excel (.xlsx), OpenOffice (.odt), RTF, Markdown, CSV/TSV, JSON/JSONL, email (.eml/.mbox), HTML, and zip/tar/tar.gz/gz archives of any of these (opened recursively; media inside is skipped). If a chat has several people, Rizzio asks "Which one is you?" and learns only your messages; text with no names on it is offered as "unlabeled lines" and only learned if you pick it. Files are parsed without AI (free). Not readable: encrypted backups (WhatsApp .crypt14), RAR/7z, and video/audio. The learned-message list is paged and searchable instead of shown all at once.
- **History**: mark which replies got a match, so Rizzio learns what works.

## It learns you

Rizzio is meant to act like you, not like a generic pickup-line bot. It keeps a memory of how you text and gets better the more you use it:

| What you do | What Rizzio learns |
|---|---|
| Add messages that worked, or teach it with chat screenshots | Your texting style: length, capitalization, emoji, humor |
| Tap a reply in the keyboard | Which style you prefer |
| Change a reply before sending | Your exact wording (strongest signal of your style) |
| 👎 a reply | What to avoid |
| Mark 💘 Match / 💬 Replied in History | What actually works for you (weighted highest) |

Every few signals it rewrites a short **style profile** of you, which you can read (and correct) in the **Train** tab. Every reply is written with that profile plus your best real messages. You can delete anything it learned, or reset it.

> Why a screenshot? iOS doesn't let keyboards see the screen. Action Button / Back Tap + Shortcuts is the most seamless way Apple allows.

## Built-in reference library

Rizzio ships with a library of good exchanges in `backend/data/corpus/`:

- `the-rizz-corpus.json`: 5,000 short, on-topic, light exchanges picked from the [the-rizz corpus](https://huggingface.co/datasets/the-rizz/the-rizz-corpus) on Hugging Face (getting-to-know-you chats). Rebuild it with `node backend/scripts/build-corpus.mjs path/to/the-rizz-corpus.txt`. The dataset page states no license, so check that before any App Store release.
- `rizzio-playbook.json`: Rizzio's own examples of Hinge prompt comments.
- `empathetic-dialogues.json`: 6,000 replies to someone sharing a feeling, from Meta's [EmpatheticDialogues](https://huggingface.co/datasets/Estwld/empathetic_dialogues_llm), labelled with the feeling. **License CC BY-NC 4.0 (non-commercial):** fine for personal use; remove or replace it before selling Rizzio.

- `synthetic-persona-chat.json`: 4,000 exchanges from Google's [Synthetic-Persona-Chat](https://huggingface.co/datasets/google/Synthetic-Persona-Chat) (CC BY 4.0): two people with short bios getting to know each other.
- `daily-dialog.json`: 5,000 exchanges from [DailyDialog](https://huggingface.co/datasets/OpenRL/daily_dialog) (CC BY-NC-SA 4.0, **non-commercial**): clean everyday conversations.
- `blended-skill-talk.json`: 4,000 exchanges from Meta's [Blended Skill Talk](https://huggingface.co/datasets/ParlAI/blended_skill_talk) (license not stated): personality, empathy and small talk combined.
- `movie-lines.json`: 1,500 strictly filtered exchanges from the [Cornell Movie-Dialogs Corpus](https://huggingface.co/datasets/spawn99/CornellMovieDialogCorpus) (no clear license; lines belong to the studios, **personal use only**). Weighted lower, so they only show up when clearly on topic.

All of these are filtered for short, on-topic, light exchanges: no parroting, no customer-service chores, no explicit or heavy topics. Rebuild them with `node backend/scripts/build-corpus-hf.mjs` (or one at a time: `persona`, `daily`, `bst`, `movie`, `empathy`). Before selling Rizzio, remove the non-commercial and unclear-license files (`empathetic-dialogues`, `daily-dialog`, `blended-skill-talk`, `movie-lines`). Considered and left out: Hinglish-Everyday-Conversations (not wanted), Reddit/Tinder scrapes (real people's private messages, crude, mostly pickup lines), Relationship_Advice (Reddit advice posts, unknown license, not texting) and HinGE (formal sentence translations, not conversation).

For each request, the server picks the few exchanges most related to what's on screen and shows them to the AI as ideas for angle and flow (free mode gets them from `POST /v1/inspiration`). They're never treated as your voice: what you upload in **Train** decides how replies sound. To add another dataset, drop a JSON file in that folder shaped like `{ "source", "kind": "chat" | "prompt", "pairs": [["their message", "a good reply"], ...] }`.

## Repo layout

| Folder | What it is |
|---|---|
| `backend/` | Node server (Railway) that holds your Claude API key, writes replies, and stores what Rizzio learns about you |
| `ios/App/` | The Rizzio app: settings, setup guide, test screen, and the "Get Rizzio Replies" Shortcut action |
| `ios/Keyboard/` | The Rizzio keyboard extension |
| `ios/Shared/` | Code used by both (API client, shared storage) |

## Setup

### 1. Backend on Railway (next to StreamScout)

The backend is a small Node server (`backend/`) that holds your Claude API key, writes the replies, and keeps Rizzio's memory of you in SQLite.

1. In Railway, open the **same project as StreamScout** → **+ New** → **GitHub Repo** → `Rizzio`.
2. In the new service → **Settings** → **Root Directory**: `backend`.
3. **Variables**:
   - `ANTHROPIC_API_KEY` = `${{StreamScout.ANTHROPIC_API_KEY}}` (reuses StreamScout's key; replace `StreamScout` with that service's exact name in Railway, or just paste the key)
   - `APP_TOKEN` = a long random password (e.g. from `openssl rand -hex 24`)
   - `DB_PATH` = `/data/rizzio.sqlite`
4. Add a Volume to the service with mount path `/data` (right-click the service → **Attach Volume**, or ⌘K → "volume"; on a phone, use **+ Create** or Safari's desktop mode). This is where your learned texting style lives. **Without it, every deploy erases everything Rizzio learned.** Check it at `/health`: it must say `"persistent": true`.
5. **Settings → Networking → Generate Domain**. You get a URL like `https://rizzio-backend-production.up.railway.app`.

Check it works:

```bash
curl https://<your-domain>/health        # {"ok":true}
curl -X POST https://<your-domain>/v1/replies \
  -H "Authorization: Bearer <APP_TOKEN>" -H "X-Rizzio-User: test-user-123" -H "Content-Type: application/json" \
  -d '{"mode":"prompt","tone":"witty","text":"Prompt: My most irrational fear. Answer: geese. they know what they did."}'
```

Run it locally with `cd backend && npm install && cp .env.example .env && npm run dev`. Tests: `npm test`.

### 2. iOS app (on a Mac)

Requirements: a Mac with **the latest Xcode** (it must support your iPhone's iOS version, e.g. Xcode 27 for iOS 27), an iPhone on **iOS 16+**, and an Apple ID (free works for testing, but the app expires every 7 days; a $99/yr Developer account removes that).

```bash
brew install xcodegen
cd ios
# Edit project.yml: replace both "com.CHANGE_ME" with something unique, e.g. com.dion
xcodegen
open Rizzio.xcodeproj
```

In Xcode:
1. Select the **Rizzio** project → for both targets (**Rizzio** and **RizzioKeyboard**) → *Signing & Capabilities* → choose your Team.
2. Check that the **App Groups** capability on both targets shows `group.com.<you>.rizzio` with a checkmark. Click ↻ if it's red.
3. Plug in your iPhone, pick it as the run destination, and press ▶︎.
4. The first time, on the iPhone: Settings → General → VPN & Device Management → trust your developer certificate.

### 3. On the iPhone

1. Open **Rizzio → Setup**, paste your server URL and APP_TOKEN, and tap Save.
2. Open the **You** tab: add a bit about yourself and a few messages that worked, then **Teach from chat screenshots** with 5–10 screenshots of your best conversations.
3. Follow the rest of the **Setup** tab: add the keyboard and turn on Full Access, build the Shortcut (Take Screenshot → Copy to Clipboard → Get Rizzio Replies → Choose from List → Copy to Clipboard), and assign it to the Action Button (Settings → Action Button → Shortcut) or Back Tap (Settings → Accessibility → Touch → Back Tap).
4. Test it on the **Try it** tab with a saved screenshot first.

## Cost

Each suggestion is one Claude API call with a compressed screenshot. To make it faster or cheaper, set the `RIZZIO_MODEL` variable in Railway (e.g. `claude-sonnet-5-5` or `claude-haiku-5-5`).

## Privacy

Screenshots go only to your own backend and the Claude API. They aren't stored on the server; only the text replies, your feedback, and messages it learned from are kept, in your own Railway database. The latest screenshot is kept on your phone (App Group) so you can regenerate in a different tone.

## Signing (TestFlight uploads)

GitHub's Macs sign builds through the App Store Connect API (`ios/scripts/asc_signing.py`). With the `SIGNING_PASSWORD` repo secret set, the first upload creates one Apple Distribution certificate and stores it in `ios/signing/`, encrypted with that password; later uploads reuse it. Keep the password safe: without it the stored certificate can't be used, and a new one is made automatically.
