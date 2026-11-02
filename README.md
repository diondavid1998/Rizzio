# Rizzio

AI reply suggestions for Hinge prompts and any text conversation, without leaving the app you're in.

**How it works**

1. On a Hinge profile, **double-tap the back of your iPhone** (Back Tap).
2. A Shortcut takes a screenshot and sends it to Rizzio in the background. Rizzio doesn't open.
3. A few seconds later you see "5 replies ready".
4. Tap the comment box, switch to the **Rizzio keyboard**, and tap a reply to insert it.

The keyboard can also:
- **Clipboard**: copy someone's message, tap Clipboard, and get 5 replies (works in iMessage, Instagram, anything).
- **Polish**: type a rough draft and get 5 better versions.
- **Tones**: Witty, Flirty, Chill, Bold, Sweet, Corny. Tap ↻ to redo the last screenshot in a new tone.

> Why a screenshot? iOS doesn't let keyboards see the screen. Back Tap + Shortcuts is the most seamless way Apple allows.

## Repo layout

| Folder | What it is |
|---|---|
| `backend/` | Small Cloudflare Worker that holds your Claude API key and writes the replies |
| `ios/App/` | The Rizzio app: settings, setup guide, test screen, and the "Get Rizzio Replies" Shortcut action |
| `ios/Keyboard/` | The Rizzio keyboard extension |
| `ios/Shared/` | Code used by both (API client, shared storage) |

## Setup

### 1. Backend (about 10 minutes, free tier)

You need a [Claude API key](https://console.anthropic.com/) and a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

```bash
cd backend
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY   # paste your Claude API key
npx wrangler secret put APP_TOKEN           # make up a long random password, e.g. from `openssl rand -hex 24`
npx wrangler deploy
```

It prints a URL like `https://rizzio-backend.<you>.workers.dev`. Check it works:

```bash
curl https://rizzio-backend.<you>.workers.dev/health        # {"ok":true}
curl -X POST https://rizzio-backend.<you>.workers.dev/v1/replies \
  -H "Authorization: Bearer <APP_TOKEN>" -H "Content-Type: application/json" \
  -d '{"mode":"prompt","tone":"witty","text":"Prompt: My most irrational fear. Answer: geese. they know what they did."}'
```

### 2. iOS app (on a Mac)

Requirements: a Mac with **Xcode 15 or newer**, an iPhone on **iOS 16+**, and an Apple ID (free works for testing, but the app expires every 7 days; a $99/yr Developer account removes that).

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

1. Open **Rizzio → Settings**, paste your server URL and APP_TOKEN, and tap Save. Add a few comments that worked for you so it copies your style.
2. Follow the **Setup** tab: add the keyboard and turn on Full Access, build the Shortcut (Take Screenshot → Get Rizzio Replies), and assign it to Back Tap (Settings → Accessibility → Touch → Back Tap).
3. Test it on the **Try it** tab with a saved screenshot first.

## Cost

Each suggestion is one Claude API call with a compressed screenshot. To make it faster or cheaper, change `RIZZIO_MODEL` in `backend/wrangler.toml` (e.g. `claude-sonnet-5-5` or `claude-haiku-5-5`) and redeploy.

## Privacy

Screenshots go only to your own backend and the Claude API. They aren't stored on the server. The latest screenshot is kept on your phone (App Group) so you can regenerate in a different tone.
