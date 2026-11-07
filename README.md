# Rizzio

AI reply suggestions for Hinge prompts and any text conversation, without leaving the app you're in.

**How it works**

1. On a Hinge profile, **press the Action Button** (iPhone 15 Pro / 16 and newer) or **double-tap the back of your iPhone** (Back Tap).
2. A Shortcut takes a screenshot and sends it to Rizzio in the background. Rizzio doesn't open.
3. A few seconds later you see "5 replies ready".
4. Tap the comment box, switch to the **Rizzio keyboard**, and tap a reply to insert it.

The keyboard can also:
- **Clipboard**: copy someone's message, tap Clipboard, and get 5 replies (works in iMessage, Instagram, anything).
- **Polish**: type a rough draft and get 5 better versions.
- **Tones**: Witty, Flirty, Chill, Bold, Sweet, Corny. Tap ↻ to redo the last screenshot in a new tone.

## The app is the control room

The everyday flow is the Action Button and the keyboard. The app is where you shape how Rizzio sounds:

- **Persona**: 12 sliders (Flirty, Humor, Boldness, Warmth, Spice, Humor style, Teasing, Length, Emoji, Polish, Questions, Pace), presets (Smooth, Golden retriever, Dry wit, Hopeless romantic, Chaos, Chill), rules like "all lowercase" and "no pickup lines", a goal (match, keep it going, number, date, friends), a "never mention" list, and a **Test drive** to see sample replies before saving. **Auto-tune** sets the sliders from how you really text.
- **Train**: upload chat screenshots (up to 20 at a time) and see exactly which of your messages Rizzio learned from each, paste messages that worked, add facts about you, and watch the **Style match** meter fill up.
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
4. Right-click the service → **Attach Volume** → mount path `/data`. This is where your learned texting style lives, so it survives redeploys.
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
3. Follow the rest of the **Setup** tab: add the keyboard and turn on Full Access, build the Shortcut (Take Screenshot → Get Rizzio Replies), and assign it to the Action Button (Settings → Action Button → Shortcut) or Back Tap (Settings → Accessibility → Touch → Back Tap).
4. Test it on the **Try it** tab with a saved screenshot first.

## Cost

Each suggestion is one Claude API call with a compressed screenshot. To make it faster or cheaper, set the `RIZZIO_MODEL` variable in Railway (e.g. `claude-sonnet-5-5` or `claude-haiku-5-5`).

## Privacy

Screenshots go only to your own backend and the Claude API. They aren't stored on the server; only the text replies, your feedback, and messages it learned from are kept, in your own Railway database. The latest screenshot is kept on your phone (App Group) so you can regenerate in a different tone.

## Signing (TestFlight uploads)

GitHub's Macs sign builds through the App Store Connect API (`ios/scripts/asc_signing.py`). With the `SIGNING_PASSWORD` repo secret set, the first upload creates one Apple Distribution certificate and stores it in `ios/signing/`, encrypted with that password; later uploads reuse it. Keep the password safe: without it the stored certificate can't be used, and a new one is made automatically.
