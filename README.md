---
title: Ephemeral Drops
emoji: 📦
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# Ephemeral Drops

A standalone version of the **Ephemeral Drops** feature extracted from the
Ephemeral Chat project. Create encrypted, self-destructing "drops" — text,
images, audio, or files — that are gated to specific recipient usernames and
disappear after viewing or expiry.

The content is encrypted **client-side** (AES-256-GCM). The server only ever
stores ciphertext and SHA-256-hashed usernames — it never sees plaintext
content or plaintext usernames.

> This project is a faithful copy of the drops feature as it works in Ephemeral
> Chat. The only net-new code is the standalone shell: a minimal Express server
> (`server/index.js`), the landing page (`client/src/components/DropsHome.jsx`),
> the trimmed router (`client/src/App.jsx`), and no-op stubs for the OHTTP /
> Privacy-Pass network layers (`client/src/crypto/ohttp.js`,
> `privacy-pass.js`) which require relay infrastructure not shipped here.
> `secureFetch` detects they are unavailable and falls back to a direct
> `fetch()` — exactly as it does in the source project when those layers are
> not configured.

## Native apps

Besides the web app, Ephemeral Drops ships as native apps for **Windows, macOS,
Linux** (Tauri 2) and **Android** (Capacitor), all wrapping the same React
client and talking to the hosted backend. See **[NATIVE.md](NATIVE.md)** for
build, signing, and release instructions.

```bash
npm run desktop:dev     # run the desktop app (hot reload)
npm run desktop:build   # build desktop installers
npm run android:sync    # build web + sync into the Android project
npm run android:open    # open Android Studio
```

## How it works

1. **Create** — pick text/image/audio/file, add recipient usernames, a TTL, and
   optionally "view once". A random AES-256-GCM master key encrypts the content;
   the master key is then wrapped once per recipient using a key derived from
   `SHA-256(username + salt)`. Only ciphertext + wrapped keys + hashed usernames
   are sent to the server.
2. **Share** — you get a drop link, a 4-word verbal code, and a downloadable
   `.eph` packet to hand to recipients.
3. **Claim** — a recipient enters the drop ID / verbal code / `.eph` file plus
   their username, which re-derives the wrapping key, unwraps the master key,
   and decrypts the content locally.
4. **Self-destruct** — drops expire on their TTL, or immediately after every
   recipient has viewed a "view once" drop.

## Project layout

```
ephemeral-drops/
├─ server/                 Minimal Express API (only /api/drops)
│  ├─ index.js             Standalone entry (new)
│  ├─ drops.js             DropManager — in-memory store + lifecycle (copied)
│  ├─ drops-routes.js      REST routes (copied)
│  ├─ wordlist.js          Verbal-code wordlist (copied)
│  ├─ utils.js             Logger + helpers (copied)
│  └─ utils/eph-file.js    .eph packet generation (copied)
└─ client/                 Vite + React UI
   └─ src/
      ├─ components/        Drop create/claim/view + StegoModal + ShareSheet (copied)
      ├─ utils/             drops.js, eph-file.js, secure-fetch.js, … (copied)
      ├─ crypto/            steganography.js (copied) + ohttp/privacy-pass stubs
      ├─ context/           ThemeContext (copied)
      ├─ i18n/              i18next setup + locales (copied)
      ├─ App.jsx            Trimmed router (new)
      └─ components/DropsHome.jsx  Landing shell (new)
```

## Running locally

Requires Node.js 18+ (developed against Node 22).

```bash
# 1. Install dependencies for both halves
npm run install:all

# 2. Configure the server secret
cp .env.example .env
# then edit .env and set EPH_SECRET, e.g.:
#   EPH_SECRET=$(openssl rand -hex 32)

# 3a. Dev mode — run the API and the Vite dev server in two terminals
npm run dev:server     # serves the API on http://localhost:3002
npm run dev:client     # serves the UI on http://localhost:5173 (proxies /api → 3002)

# 3b. Or production mode — build the client, then serve everything from the API
npm run build
npm start              # http://localhost:3002 serves UI + API
```

## Deployment

- Set `EPH_SECRET` (required) and `APP_URL` (the public URL) in the environment.
- Run `npm run build` to produce `client/dist`, then `npm start`. The server
  serves the built client and the `/api/drops` API from the same origin, so no
  CORS configuration is needed for the app itself.
- By default, encrypted blobs are stored **in memory** — restarting the server
  clears all active drops, and uploads are capped at 25 MB. To support large
  uploads on a tiny server, enable Cloudflare R2 storage (below).

## Cloudflare R2 storage (optional, for large uploads)

When R2 is configured, the server stops holding the encrypted payload in RAM.
Instead the browser uploads ciphertext **directly to the R2 bucket** through a
one-time presigned URL, and downloads it the same way on claim. The server only
stores small metadata (wrapped keys, recipient hashes, verbal code, the object
key, TTL). This keeps the server lightweight and raises the upload cap to
**100 MB**. R2's free tier (10 GB storage, free egress) easily covers an
ephemeral app, since every drop is deleted on its TTL or after view-once.

**1. Set the environment variables** (see `.env.example`). All four are required
to switch into R2 mode — if any is missing, the app silently falls back to
in-memory storage:

```
R2_ACCOUNT_ID=...          # Cloudflare account ID (R2 dashboard)
R2_ACCESS_KEY_ID=...       # from R2 → Manage R2 API Tokens (Object Read & Write)
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=...              # your bucket name
```

**2. Add a CORS policy to the bucket** so browsers may upload/download directly.
In Cloudflare → R2 → your bucket → Settings → CORS Policy, paste (replace the
origin with your deployed app URL; add `http://localhost:5173` for local dev):

```json
[
  {
    "AllowedOrigins": ["https://your-app-url.example"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Without this CORS rule, the browser blocks the direct transfer and create/claim
will fail at the upload/download step.

How it flows:

1. Browser encrypts the file locally (unchanged).
2. `POST /api/drops` sends only metadata + byte size → server replies with a
   presigned `uploadUrl`.
3. Browser `PUT`s the ciphertext straight to R2.
4. On claim, the server returns a presigned `downloadUrl`; the browser fetches
   the ciphertext from R2 and decrypts locally.
5. On TTL expiry / view-once / creator delete, the server removes the R2 object
   (view-once deletes are delayed briefly so an in-flight download can finish).

## Limits (inherited from the source feature)

- Max payload: 25 MB encrypted in-memory, or up to **1 GB** with R2 enabled
  (UI caps uploads to match the active storage mode; the practical ceiling for
  large files is the browser's memory while encrypting)
- Payloads use a chunked AES-256-GCM format (`client/src/crypto/large-file-crypto.js`):
  each block is independently authenticated, so a corrupted, truncated, or
  reordered download fails to decrypt rather than returning bad data
- Max recipients per drop: 20
- Max active drops per creator: 10
- TTL options: 5 min, 15 min, 30 min, 1 hour, 6 hours, 24 hours
- Rate limits: 10 creates / 30 claims per 10 minutes per IP
