# Publishing to gducalc.mplfarms.com

**This is already live** at https://gducalc.mplfarms.com — Netlify project
`gducalc`, GoDaddy CNAME `gducalc` → `gducalc.netlify.app`. The steps below are
the record of how it got there; for routine updates skip to "Shipping an update
later" at the bottom.

Same pattern as the Corn Plot app, which today runs as its own Netlify site
(`cornplotentry.netlify.app`) with `cornplot.mplfarms.com` pointed at it by a
CNAME. mplfarms.com itself is your landing page on a different host and is not
touched by any of this.

**Do it as its own Netlify site on its own subdomain — not as a folder inside the
Corn Plot site.** Three concrete reasons:

1. Every path in this app is absolute (`/css/gdu.css`, `/js/main.js`). Serving it
   from `cornplot.mplfarms.com/gdu/` would break all of them.
2. A service worker claims scope for its whole origin. Two apps on one origin
   means two service workers fighting over the same scope, and whichever
   registers last starts answering for both.
3. Anything you push to the Corn Plot repo redeploys the app your reps are
   actively entering plot data into. A separate site means a bad GDU build can't
   take that down.

---

## 1. Make the GitHub repo

1. Unzip the latest `gdu-calculator-vX.Y-repo.zip`. You'll get a folder with `public/`,
   `netlify.toml`, `test/`, `README.md` and this file.
2. On github.com: **+ → New repository**. Name it `gdu-calculator`. Private is
   fine — Netlify can read private repos once you connect it. Do **not** tick
   "Add a README" (the zip already has one).
3. On the empty repo page: **uploading an existing file** → drag in the
   *contents* of the unzipped folder (`public`, `netlify.toml`, `test`,
   `README.md`, `DEPLOY.md`, `package.json`, `.gitignore`, `data-src-hybrids.csv`).

   Drag the folders themselves, not their contents — GitHub's web uploader keeps
   the folder structure. What must end up at the repo root is `netlify.toml`,
   with `public/` as a folder beside it.
4. **Commit changes.**

Sanity check before moving on: browsing the repo, you should see `netlify.toml`
at the top level and `public/index.html` one level down. If `index.html` ended up
at the root, the upload flattened the folders — delete and re-upload by dragging
the folders rather than opening them first.

## 2. Make the Netlify site

1. Netlify → **Add new site → Import an existing project → GitHub** → pick
   `gdu-calculator`.
2. Netlify reads `netlify.toml` and fills the settings in for you. Confirm they
   read:
   - **Build command:** *(empty)*
   - **Publish directory:** `public`
   - **Functions directory:** *(empty — this app has none)*
3. **Deploy.** It's a static upload with no build step, so it finishes in well
   under a minute.
4. **Site configuration → Change site name** → `gducalc`, giving you
   `gducalc.netlify.app`. Open it and confirm the app loads before touching
   DNS.

## 3. Point gducalc.mplfarms.com at it

1. Netlify → **Domain management → Add a domain** → `gducalc.mplfarms.com`. Netlify
   will say the domain isn't managed by them and show you the DNS record it
   wants.
2. At your DNS host (the same place `cornplot.mplfarms.com` is configured), add:

   | Type | Name | Value | TTL |
   |---|---|---|---|
   | CNAME | `gducalc` | `gducalc.netlify.app` | default / 1 hour |

   This is exactly the shape of the existing `cornplot` record — that one is a
   CNAME to `cornplotentry.netlify.app`.
3. Wait for propagation (usually minutes, occasionally an hour), then in Netlify
   **Domain management → HTTPS → Verify DNS configuration**. Netlify issues the
   Let's Encrypt certificate automatically once the CNAME resolves. Don't skip
   it — service workers only register over HTTPS, so without the cert the app
   won't cache, won't work offline, and won't install to a home screen.

## 4. Check it works

On a phone, at `https://gducalc.mplfarms.com`:

- [ ] Brand View picker appears on first load; picking one themes the app
- [ ] A ZIP lookup returns the right town
- [ ] **Choose from Hybrid List** shows all 134 hybrids
- [ ] Calculate returns a chart within a few seconds
- [ ] The share button produces a PDF
- [ ] Add to Home Screen installs it with its own icon, and it opens offline far
      enough to show the input screen *(this is the HTTPS check — the service
      worker silently refuses to register on plain http)*

## Shipping an update later  ← the part you need now

Replace the changed files in the GitHub repo (web UI: open the file → pencil →
paste → commit, or drag a replacement through **Add file → Upload files**).
Netlify redeploys on every push to the default branch.

Two files to bump together on every build, or returning users get served the old
app from their service worker cache:

- `public/js/version.js` → `APP_VERSION` (the label on the Settings screen)
- `public/sw.js` → `CACHE_VERSION` (what actually invalidates the cache)

Same convention as the Corn Plot app, and the comments in both files say so.

## If you'd rather skip GitHub entirely

Netlify's **Sites → Add new site → Deploy manually** takes a drag-and-drop of the
`public` folder and puts it live immediately. It's the fastest way to see it on a
real URL. The trade-off is real, though: no history, no rollback, and the next
update means remembering exactly which folder you dragged last time. Fine for a
first look; use the GitHub route for anything you'll maintain.

## What this app does NOT need

The Corn Plot site carries Netlify Functions, the `@netlify/plugin-functions-install-core`
plugin, and Netlify Blobs for cloud sync and the shared hybrid catalog. None of
that applies here. This app has no accounts, no server, and no shared state — it
reads free public weather APIs directly from the browser and keeps your saved
hybrids in that device's own local storage. If Netlify's build log mentions
functions or plugins, something got copied over from the other project's config.
