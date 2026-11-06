import { ClaudeAI } from "./ai.js";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

const { ANTHROPIC_API_KEY, APP_TOKEN, RIZZIO_MODEL, PORT = 4000, DB_PATH = "./rizzio.sqlite" } = process.env;

if (!ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY is not set: reply requests will fail.");
if (!APP_TOKEN) console.warn("APP_TOKEN is not set: every request will be rejected.");

const store = openDb(DB_PATH);
const ai = new ClaudeAI({ apiKey: ANTHROPIC_API_KEY, model: RIZZIO_MODEL });
const app = createApp({ store, ai, appToken: APP_TOKEN });

app.listen(PORT, () => console.log(`Rizzio backend listening on :${PORT} (db: ${DB_PATH})`));
