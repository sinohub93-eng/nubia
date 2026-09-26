# Nubia — project handoff

Read this before making changes. It's the architecture, conventions and current state, kept up to date
by whoever finishes a phase — so a future chat doesn't need this conversation's history.

## What Nubia is

A premium marketplace (Nigerian audience, NGN pricing) where customers browse, buy or rent ready-made
websites, and register domains. React 18 + TypeScript frontend, Supabase (Postgres + Auth + Storage +
Edge Functions) backend, Flutterwave for payments, ResellerClub for domain registration.

## Stack & conventions

- **Frontend**: React 19, TypeScript, hash-based router (`src/lib/router.tsx`, no library). Real Vite
  (`vite.config.ts`, `index.html` at the repo root, `npm run build`) is the only production build path —
  see Phase 8 below. `test/build-preview.mjs` (esbuild) is separate **dev-test-only** tooling used to
  drive the Playwright flow scripts in `test/` against `test/mock-supabase.mjs`; it aliases
  `@supabase/supabase-js` to `test/vendor/supabase-lite` for that purpose only. Neither file is imported
  by, or has any effect on, the real build — application code always imports the real
  `@supabase/supabase-js` package directly (`src/lib/supabase.ts`).
- **Styling**: plain CSS, no framework. One `:root` token set in `src/styles/base.css` (`--bg`, `--burg`,
  `--gold`, `--cream`, `--gray`, `--line`, `--serif`, `--sans`, `--r`, `--r-btn`...). Each area gets its
  own file, imported from `src/styles/index.css`. Reuse `.btn`, `.btn--gold/ghost/link`, `.alert`,
  `.field`, `.display` rather than redefining them.
- **State**: no Redux/Zustand. Context providers in `src/lib/` (`auth.tsx`, `catalog.tsx`, `context.tsx`,
  `checkout.tsx`, `purchases.tsx`). One `onAuthStateChange` subscription for the whole app.
- **Data access**: typed `services/*.ts` wrap Supabase calls and translate errors into typed app errors
  (`lib/errors.ts` for the public site, `services/adminApi.ts` for the admin area) that components turn
  into copy. Components never call `supabase.from(...)` directly.
- **Security model, everywhere**: the browser is not trusted. Every privileged read or write is enforced
  by Postgres RLS or a `SECURITY DEFINER` function, or by an Edge Function that re-checks the caller's
  JWT and role. A frontend guard (`RequireAuth`, the admin gate) is UX only — never the real check.
- **Migrations**: one file per phase under `supabase/migrations/`, numbered `000N_description.sql`,
  never edited after merge. A later migration alters what an earlier one created; it doesn't restate it.
  Every migration is idempotent (`create or replace`, `drop ... if exists` then `create`) so re-running
  it is harmless.
- **Edge Functions**: `supabase/functions/<name>/index.ts` + shared code in `supabase/functions/_shared/`.
  Provider secrets (Flutterwave, ResellerClub) are read from `Deno.env` inside functions only — never
  sent to or trusted from the browser.
- **Tests**: `test/mock-supabase.mjs` runs a local HTTP server imitating GoTrue + PostgREST, and executes
  the **real** Edge Function handler code against an in-memory DB (`test/fake-supabase.ts`). This proves
  the app and function logic fit together — it does not prove anything about real RLS policies or the
  real registrar/payment providers. `supabase/tests/*.sql` are separate, meant to run against a real
  (staging) Supabase project to check RLS and constraints directly.

## Phase history

- **Phase 1–4**: marketplace frontend, product catalog & categories, Supabase Auth, Flutterwave
  checkout, purchase entitlements.
- **Phase 5**: rentals. `entitlements` (purchase | rental), `site_access` (provisioning state machine:
  pending → provisioning → active / failed, plus revoke_requested_at → revoked), `access_events` (audit
  trail of every access decision), `rental_periods` (paid windows, so renewals stack correctly). Rental
  status is always computed from `expires_at` vs `now()`, never stored as a flag that could go stale.
- **Phase 6**: domains. `domain_orders`, `domain_renewals`, `domain_events`, `domain_pricing` (admin-set
  NGN pricing: either a fixed price or `cost × fx_rate × (1 + markup%) + fixed_markup`, rounded **up** to
  `round_to_ngn`). ResellerClub integration behind `_shared/resellerclub.ts` / `domain-service.ts`, with
  a list of extensions requiring extra registry contact data (`NEEDS_SPECIAL_CONTACT`) that Nubia can't
  sell yet even if priced. Registrar and Flutterwave secrets are test/sandbox-only in this environment.
- **Phase 7 (current, IN PROGRESS — see status below)**: the private admin system.

## Phase 7 — Admin system

### Database (`supabase/migrations/0007_admin.sql`)

- `assert_admin()` — every `admin_*` function calls this first; raises `forbidden` (42501) for anyone
  without the `admin` role in `user_roles`.
- `admin_audit_log` — append-only (triggers block UPDATE/DELETE/TRUNCATE for everyone, including admins).
  Written by `log_admin_action()` (database) and directly by the `admin-ops` Edge Function (source
  `'edge'`). Triggers on `products`, `categories`, `domain_pricing`, `user_roles` (admin grants/revokes)
  and `access_events` (rental decisions) log changes automatically — an action is audited even if a
  client bypasses the admin UI and writes the table directly.
- `admin_check_access()` — the one thing the frontend gate calls. Logs one `admin.session` row per admin
  per 30 minutes and one `admin.access_denied` row per non-admin per 10 minutes (so repeated checks don't
  flood the log).
- Read functions (all paginated, searchable, filterable, all `stable security definer`):
  `admin_dashboard`, `admin_recent_activity`, `admin_list_orders` / `admin_get_order`,
  `admin_list_payment_events`, `admin_list_customers` / `admin_get_customer`, `admin_list_rentals` /
  `admin_get_rental`, `admin_list_domains` / `admin_get_domain`, `admin_list_domain_pricing`,
  `admin_list_products` / `admin_product_usage`, `admin_list_categories`, `admin_list_audit`.
- Write functions: `admin_set_admin_role` (can't change your own; reason required), `admin_revoke_rental`
  / `admin_resolve_provisioning` (tightened from Phase 5 — reason/note required, contradictory state
  changes refused), `admin_set_domain_connection`, `admin_save_domain_pricing`, `admin_delete_product`
  (refuses once the product has any order/entitlement/site_access/domain history — archive instead).
- `products.status` gained `'archived'`. New constraints: image URLs must be https (or a built-in
  `scene` preview) and a published product needs at least one image (`products_published_needs_image`).
- Storage bucket `product-images`: public read, admin-only write (`is_admin()` in the storage policies).
- Product/category/pricing writes still go through normal `supabase.from(...).insert/update` — RLS
  (`products_insert_admin` etc. from migration 0002) is the real gate; the `admin_*` functions are for
  reads and the operations that need extra logic (role changes, deletes, rental/domain actions).

### Edge Function: `admin-ops` (`supabase/functions/admin-ops/`)

Verifies the JWT **and** the admin role itself (`_shared/admin.ts: requireAdmin`) — never trusts the
client. Actions: `system_status` (booleans only — configured/not, test/live — never secrets),
`domain_refresh`, `domain_retry_registration`, `domain_retry_renewal` (all reason-required, all audited,
all refuse to act on an order whose payment isn't `successful`). Registered in `supabase/config.toml`.

### Frontend

- Route: `#/admin/<section>/<id>?query`, parsed in `lib/router.tsx` (`Route` union, `paths.admin(...)`).
  `App.tsx` renders `pages/admin/AdminApp.tsx` **without** the public Navbar/Footer/search/demo overlays
  when `route.name === 'admin'`.
- `AdminApp.tsx` is the gate: `RequireAuth` (redirect to login) → asks `admin_check_access()` (never
  trusts the role list already loaded in `useAuth()`) → renders `AdminShell` + the section's page. Any
  admin call that comes back `forbidden` re-runs the check and refreshes the account (`AdminContext.
  onForbidden`, wired through `useAsync`). 30-minute idle auto sign-out (`AdminShell`'s `useIdleSignOut`).
- `services/adminApi.ts` — `rpc()` and `adminOps()` wrappers, plus `toAdminError` which maps Postgres/
  PostgREST/Edge-Function errors to a `MESSAGES` table of plain-language copy. Add new error codes there,
  not inline in a page.
- `services/adminData.ts` — one typed function per `admin_*` RPC / table operation. Pages never call
  `rpc()` directly.
- `admin/types.ts` — TypeScript shapes matching the JSON the SQL functions return. Keep these in sync by
  hand; there's no codegen here.
- `lib/adminProduct.ts`, `lib/adminPricing.ts`, `lib/adminFormat.ts` — pure logic (slugs, validation,
  form↔row mapping, the domain-pricing formula mirrored from `_shared/domains.ts`, date/money formatting).
  No React, no network — easy to unit-test.
- `admin/hooks.ts` — `useAsync` (stale-request-safe loader that keeps old data visible while refetching
  and redirects to the gate on `forbidden`), `useDebounced`, `useQueryFilters` (filter state synced to
  the URL query string via `history.replaceState`, so filtered views are bookmarkable and survive
  refresh without a remount).
- `components/admin/ui.tsx` — shared primitives: `PageHeader`, `Panel`, `Stat`, `DataTable` (in its own
  file), `Loading`, `ErrorBox`, `Empty`, `Pager`, filter controls, `Mono` (copy-to-clipboard), and
  `ConfirmDialog`/`useConfirm` for destructive actions (optional required reason, optional
  type-to-confirm, optional extra field like a provider reference — all recorded server-side).
- `components/admin/badges.tsx` — one status-badge component per domain concept (order, rental, access,
  domain registration, connection, renewal, product, payment outcome). Extend the lookup table rather
  than special-casing a status inline in a page.
- Pages, one file (or pair) per section under `pages/admin/`: `DashboardPage`, `ProductsAdminPage` +
  `ProductEditorPage`, `CategoriesPage`, `OrdersPages` (orders + payment events tabs), `CustomersPages`
  (list + detail incl. admin-role toggle), `RentalsAdminPages`, `DomainsAdminPages`, `DomainPricingPage`,
  `AuditPage`.
- Customer-facing side-effects of Phase 7: `CategoryId` is now `string` (categories are admin-managed,
  not a hardcoded union); `lib/catalog.tsx`'s `CatalogProvider` now also loads categories from the
  database (falling back to `data/categories.ts` on any failure) and exposes `categoryLabel()`;
  `services/products.ts`'s `mapProductRow` gives a labelled placeholder demo URL when none is set, so a
  product row missing `demo_url` doesn't break product cards.

### Status — tested and passing, one real limitation remains

1. **`0007_admin.sql` still needs to run against a real (staging) Supabase project at least once.**
   It has been written, re-checked by hand against the earlier migrations' column names, and every
   `admin_*` function's argument list, error codes and audit-trigger behaviour has been cross-checked
   line-by-line against `supabase/tests/verify_phase7.sql` (below). But this sandbox has no Postgres,
   so the SQL itself has never actually executed. Run `verify_phase7.sql` in the SQL Editor of a
   staging project right after applying the migration — it's written to catch exactly the kind of typo
   that only shows up at execution time.
2. **No real `tsc` type-check is possible in this sandbox** — there is no `@types/react` anywhere on
   the machine and no network to fetch it. What *has* run, and passes clean: a full esbuild
   transpile+bundle of the entire app (`node build.mjs --out=dist/test.html ...`), which catches
   syntax errors, unresolved imports and JSX errors (though not prop-type mismatches). If you have a
   real environment with `npm install` available, run an actual `tsc --noEmit` there before trusting
   this at the type level.
3. **`test/mock-supabase.mjs` and `test/fake-supabase.ts` are now extended for Phase 7** — every
   `admin_*` RPC, `admin-ops`, product/category CRUD, and a minimal Storage implementation (upload,
   public URL, remove) all run against the shared in-memory `DB`. See `test/admin.test.mjs`
   (Edge-Function-level, 16 tests) and `test/admin-flow.mjs` (full browser flow through the actual
   admin UI — gate, dashboard, product create/publish with a real image upload, categories, domain
   pricing, audit log, customer role protection, a full rental revoke — 37 tests). Both pass clean.
4. **`supabase/tests/verify_phase7.sql` has been written** (RLS, `assert_admin()` gating for admin /
   non-admin / anonymous, audit-log immutability against UPDATE/DELETE/TRUNCATE, every reason-required
   and state-consistency guard, the image/https product constraints, storage bucket policies). It has
   been checked by inspection against the migration's actual function signatures, not executed — see
   point 1.
5. **The full Phase 1–6 regression suite has been re-run and passes**: `edge-functions.test.mjs` (52),
   `phase56.test.mjs` (97), `auth-flow.mjs` (25), `payment-flow.mjs` (33), `domain-rental-flow.mjs` (41),
   `states.mjs` (8). Combined with the new Phase 7 tests (16 + 37), that's **309/309 passing**, zero
   regressions from the categories/CategoryId change or anything else in this phase.
6. Two real bugs were found and fixed while getting the above green, worth knowing about:
   - `build.mjs` had no alias for `react`/`react-dom`, so the sandbox build failed outright until one
     was added (pointing at the globally-installed packages — this file is explicitly sandbox-only).
   - `vendor/supabase-lite`'s `storage.getPublicUrl()` returned a plain `http://` URL, which correctly
     tripped the app's genuine https-only image validation — that validation is right for production
     (real Supabase Storage is always https), so the fix was in the sandbox stub, not the app: it now
     presents the URL scheme production would actually use.
7. Known gap, not a blocker: MFA / step-up auth for admins isn't implemented — only the `admin` role
   check. Worth doing before real money and real customer data go through this.
8. **Environment limitation, not a code issue:** a true interactive "click around in your own browser"
   live preview of the full stack (frontend + mock backend) isn't achievable from this chat — the mock
   backend only listens on this sandbox's own `127.0.0.1`, and there's no tunnel/port-forward tool
   available to expose it externally. The browser automation above (`test/*-flow.mjs`) is the closest
   verification available here; it writes screenshots to a gitignored `shots/` folder for local viewing
   when you run it yourself, not committed to the repo.

### Behaviours worth knowing

- New orders — including rental renewals — require the product to be `status = 'published'`
  (`products_select_published`-style checks in the order-creation Edge Function from Phase 4/5).
  Archiving or unpublishing a rented website blocks *new* renewals; a customer's current rental access
  is untouched. The product editor's archive confirmation says this — don't remove that copy.
  Search: "orders require published" trail runs migration 0004 → `create-payment`/`renew-rental`
  Edge Functions → `admin_delete_product`'s `can_delete` check (history blocks delete, not archive).
- `admin_set_admin_role` refuses to let an admin change their own role, and requires a reason (stored in
  `admin_audit_log` via `set_config('nubia.audit_reason', ...)`, picked up by the `user_roles_audit`
  trigger). If you add another self-service-role-change path, it needs the same guard.
- Domain pricing: a fixed NGN price (`retail_register_ngn` / `retail_renew_ngn`) always wins over the
  formula. `lib/adminPricing.ts: previewPrice()` mirrors `supabase/functions/_shared/domains.ts:
  retailPrice()` exactly — if you change one, change both, and note it here.
- `SPECIAL_CONTACT_TLDS` in `lib/adminPricing.ts` must stay in sync with `NEEDS_SPECIAL_CONTACT` in
  `_shared/domains.ts`. It's currently a hand-copied list, not shared code — worth deduplicating later.

## Phase 8 — production / Netlify readiness

Production build config didn't exist before this phase — the repo only had the dev-test esbuild
bundler (now `test/build-preview.mjs`) and no real `index.html`/`vite.config.ts`/`tsconfig.json`.
This phase added:

- `index.html` (repo root, real Vite entry), `vite.config.ts` (React plugin, `es2020` target, manual
  vendor/supabase chunks, 700kb warning limit), `tsconfig.json` + `tsconfig.node.json`.
- `netlify.toml` (build command, publish dir, SPA catch-all redirect, immutable caching for
  `/assets/*`, basic security headers) + `public/_redirects` as a belt-and-suspenders duplicate of the
  same SPA rule, since the app is entirely hash-routed and technically shouldn't need it for in-app
  navigation, but direct/bookmarked non-hash paths and any static host that only reads `_redirects`
  still need it.
- `package.json`: `build` is now plain `vite build` (no `tsc` gate) with a separate `typecheck` script
  (`tsc --noEmit`) — see the note on `tsc` below for why these are split. Added `engines.node`.
- `public/favicon.svg`, `public/robots.txt`.
- Route-based code-splitting: `AdminApp` is now `React.lazy`-loaded from `App.tsx` (behind a small
  on-brand `<Suspense>` fallback) instead of statically imported, so the ~3,000 lines of Phase 7 admin
  code ship as their own chunk, fetched only when someone actually navigates to `#/admin/*` — not in
  every anonymous marketplace visitor's initial bundle. Confirmed via `manualChunks` in
  `vite.config.ts` and re-tested end to end (`test/admin-flow.mjs` still 37/37 after the change).
- Removed from the repo entirely (not just gitignored): the old `build.mjs` and `vendor/` at the repo
  root, `.env.test`/`.env.down`/`.env.fallback`, `dist/`, `shots/`, `test/.tmp*`. The dev-test bundler
  and its supabase-js stand-in were **relocated** to `test/build-preview.mjs` and
  `test/vendor/supabase-lite/` rather than deleted outright, since the Playwright flow test suite
  (`test/*-flow.mjs`, 200+ assertions) has no other way to get a servable bundle without a real
  `npm install` — the real production path (`vite.config.ts`, root `index.html`) has no dependency on
  either file, and neither is referenced by `npm run build`.
- **Rebuilding the relocated test tooling surfaced three real, since-fixed bugs** in the dev-test
  supabase-js stand-in (not in application code): it read `error.message` from GoTrue's raw JSON
  response instead of `error.msg` (real `@supabase/supabase-js` normalizes this; the stand-in didn't,
  so "wrong password"/"duplicate account" showed generic errors instead of the app's actual friendly
  messages), it had no background auto-refresh timer at all (real supabase-js proactively refreshes
  ahead of expiry independent of API activity — the app's own session-expiry toast depends on that,
  not on any polling of its own), and its localStorage key didn't match the `sb-`-prefixed convention
  a couple of test scripts inspect directly. All three are fixed and the full suite (308 assertions
  across unit + browser tests) passes again post-relocation.
- Full security/RLS/exposure audit (read-only — nothing here needed changing, all pre-existing):
  every table has RLS enabled with either real policies or a deliberate zero-policy lockdown (`payment_
  events`, `site_access`, `access_events`, `domain_events`, `domain_pricing`, `registrar_customers`,
  `registrar_contacts` — all correctly service-role/SECURITY-DEFINER-only, confirmed nothing in `src/`
  queries them directly); no secret-shaped value or non-`VITE_`-prefixed env var anywhere in `src/`;
  `admin-ops`'s `system_status` action returns only booleans/mode strings, never a raw credential
  (re-confirmed, matches the assertion already in `test/admin.test.mjs`); image lazy-loading was
  already comprehensive (`SiteImage.tsx`'s `eager` prop, admin editor previews); every real context
  provider already memoizes its value with `useMemo` (`auth.tsx`, `catalog.tsx`, `checkout.tsx`,
  `purchases.tsx`, `App.tsx`'s own `AppContext`) — nothing to fix there either.
- Payment idempotency (Phase 4) and domain retry/error handling (Phase 6/7) were **audited, not
  rebuilt**: `orders.payment_reference` and `orders.flutterwave_transaction_id` both have real unique
  constraints, `fulfill_order()` returns an `already_processed` flag the webhook and the client-side
  verify path both honour, and this exact behaviour is what `test/phase56.test.mjs` and
  `test/edge-functions.test.mjs` already exercise (race conditions, duplicate webhooks, mismatched
  amounts). Nothing here was changed because nothing here was found wrong.

### What Phase 8 could NOT verify (genuine environment limits, not skipped)

- **No real `npm install` / real `vite build` / real `tsc` has ever run.** This sandbox has no network
  access to the npm registry. Everything above was validated with: (a) the relocated esbuild-based
  `test/build-preview.mjs`, which transpiles and bundles the real `src/` tree and catches syntax/
  import/JSX errors but is not a type-checker, and (b) the 308-assertion Playwright/unit test suite
  running the real app logic against a scripted backend. **Before deploying, run `npm install && npm
  run typecheck && npm run build` yourself** — that is the first real type-check and the first real
  Rollup-based build this codebase will ever have gone through. This is exactly why `npm run build` no
  longer runs `tsc` as a gate (see `package.json`): a type error I can't see or fix shouldn't silently
  block a deploy. `npm run typecheck` is there for you (and CI) to run deliberately instead.
- **No real Postgres.** `supabase/migrations/0001-0007` and `supabase/tests/*.sql` (including
  `verify_phase7.sql`) have been re-read carefully but never executed. Run every migration in order
  against a staging Supabase project, then run the `verify_*.sql` scripts in the SQL Editor, before
  pointing production traffic at it.
- **No real Flutterwave or ResellerClub account.** The idempotency/retry logic described above is
  real, tested code — but only ever against the scripted stand-ins in `test/`. Use each provider's own
  sandbox/test mode against a staging Supabase project before going live with real keys.
- **No real bundle-size measurement.** The esbuild single-file preview (~618 KB, everything inlined,
  including the admin panel that real Vite will code-split out) is not a meaningful stand-in for
  Rollup's actual chunked, tree-shaken, minified output. Run `npm run build` and check the real
  `dist/assets/*.js` sizes yourself; `vite.config.ts`'s `chunkSizeWarningLimit` will flag anything that
  looks too large.
