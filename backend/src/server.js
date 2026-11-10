import { ClaudeAI } from "./ai.js";
import { createApp } from "./app.js";
import { FakeAI } from "./fakeAI.js";
import { openDb } from "./db.js";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const { ANTHROPIC_API_KEY, APP_TOKEN, RIZZIO_MODEL, RIZZIO_FAKE_AI, PORT = 4000, RAILWAY_VOLUME_MOUNT_PATH, RAILWAY_ENVIRONMENT } = process.env;

// Where learned voices live. It must be on a Railway Volume, or every deploy starts from an empty database.
// Railway tells us where an attached volume is mounted, so use it unless DB_PATH says otherwise.
const volume = RAILWAY_VOLUME_MOUNT_PATH ? resolve(RAILWAY_VOLUME_MOUNT_PATH) : null;
const DB_PATH = process.env.DB_PATH || (volume ? join(volume, "rizzio.sqlite") : "./rizzio.sqlite");
const persistent = volume ? resolve(DB_PATH).startsWith(volume + "/") : !RAILWAY_ENVIRONMENT;
if (!persistent) {
  console.error(
    volume
      ? `WARNING: DB_PATH (${DB_PATH}) is not on the volume at ${volume}. Learned data will be lost on every deploy.`
      : "WARNING: no Railway Volume is attached. Learned data will be lost on every deploy. Add a Volume to this service.",
  );
}
mkdirSync(dirname(resolve(DB_PATH)), { recursive: true });
const fake = RIZZIO_FAKE_AI === "1";

if (fake) console.warn("RIZZIO_FAKE_AI=1: using canned test replies, not Claude.");
else if (!ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY is not set: reply requests will fail.");
if (!APP_TOKEN) console.warn("APP_TOKEN is not set: every request will be rejected.");

const store = openDb(DB_PATH);
const ai = fake ? new FakeAI() : new ClaudeAI({ apiKey: ANTHROPIC_API_KEY, model: RIZZIO_MODEL });
const app = createApp({ store, ai, appToken: APP_TOKEN, storage: { persistent } });

app.listen(PORT, () => console.log(`Rizzio backend listening on :${PORT} (db: ${DB_PATH})`));
