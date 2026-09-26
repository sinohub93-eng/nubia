# Nubia

React + TypeScript marketplace for buying and renting professionally designed websites, with domain
registration and a private admin system. Supabase (Postgres + Auth + Storage + Edge Functions) backend,
Flutterwave for payments, ResellerClub for domains.

## Run locally

```bash
npm install
cp .env.example .env      # add your project URL + publishable key (never the service-role key)
# apply supabase/migrations/*.sql in order, in the Supabase SQL Editor (see supabase/README.md)
npm run dev
```

`VITE_SUPABASE_URL` is the bare project URL (`https://<ref>.supabase.co`, without `/rest/v1`).
Keep `VITE_ALLOW_SAMPLE_FALLBACK=false` in production so backend failures show as errors, not sample data.

## Build & deploy (Netlify)

```bash
npm run build      # vite build -> dist/
npm run preview    # serve the production build locally to sanity-check it
```

On Netlify: connect the repo, build command `npm run build`, publish directory `dist` (already set in
`netlify.toml`, including the SPA redirect so direct navigation and page refreshes work on every route).
Set these as **Netlify site environment variables** (Site settings → Environment variables), never
committed to the repo:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_FLW_PUBLIC_KEY`
- `VITE_ALLOW_SAMPLE_FALLBACK` — set to `false` for production

These are all browser-safe, publishable values by design (see `src/lib/env.ts`). Nothing secret
(`FLW_SECRET_KEY`, `FLW_SECRET_HASH`, `RESELLERCLUB_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, ...) is ever
read from the frontend — those live only in Supabase's Edge Function secrets, set via the Supabase CLI
or dashboard, never in this repo or in Netlify's build environment. See `.env.example` for the full list
and where each one belongs.

Before pointing production traffic at a project: run every file in `supabase/migrations/` in order
against it, then run `supabase/tests/verify_phase7.sql` (and the other `supabase/tests/*.sql` files) in
the SQL Editor to confirm RLS, the admin gate, and the audit trail actually behave as intended on that
real database — this repo's own test suite (below) only checks the app and Edge Function *logic* against
a scripted stand-in, not real Postgres RLS.

## Structure

```
index.html                  Vite entry point
vite.config.ts               build configuration (code-split admin chunk, vendor chunk, etc.)
netlify.toml, public/_redirects   Netlify build command, publish dir, SPA fallback, cache headers
src/lib/supabase.ts          the single Supabase client (requireClient)
src/lib/env.ts               browser-safe config (URL normalisation, missing-variable detection)
src/lib/errors.ts            error classification -> polished messages (raw errors never reach the UI)
src/lib/auth.tsx             AuthProvider / useAuth / useAccessLevel (one session listener for the app)
src/services/                products.ts, profile.ts, roles.ts, auth.ts, adminData.ts  (all Supabase queries live here)
src/pages, components/       UI (marketplace, product, auth, account)
src/pages/admin, admin/      the private admin panel (code-split, lazy-loaded — see App.tsx)
supabase/                    migrations (0001-0007), Edge Functions, RLS verification SQL, notes
test/                        the test suite (Edge Function unit tests + Playwright browser flows) and its
                              own local stand-in for Supabase — none of it ships or affects the Netlify build
CLAUDE.md                    architecture notes, phase history, and current known-gaps for anyone picking this up
```

## Tests (dev-only; none of these run during `npm run build` or affect the Netlify deploy)

The whole suite runs against a scripted local stand-in for Supabase/Flutterwave/ResellerClub
(`test/mock-supabase.mjs`, `test/fake-supabase.ts`) — useful for catching logic regressions quickly, but
not a substitute for the real RLS checks in `supabase/tests/*.sql` above.

```
node test/edge-functions.test.mjs     payment Edge Function logic
node test/phase56.test.mjs            rentals + domains Edge Function logic (scripted Flutterwave / ResellerClub)
node test/admin.test.mjs              admin-ops Edge Function logic (JWT + admin-role checks, retries)

node test/mock-supabase.mjs &         start the local backend stand-in, then:
  node test/build-preview.mjs --out=test/.tmp/preview.html --url=http://127.0.0.1:54321
                                         (a small esbuild-based preview bundle for the flow scripts below;
                                          see the file's header — it has no bearing on the real `npm run build`)
  node test/auth-flow.mjs
  curl http://127.0.0.1:54321/__reset && node test/payment-flow.mjs
  curl http://127.0.0.1:54321/__reset && node test/domain-rental-flow.mjs
  curl http://127.0.0.1:54321/__reset && node test/admin-flow.mjs
                                         (each flow script expects a freshly reset backend)
```
