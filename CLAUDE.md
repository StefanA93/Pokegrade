# CLAUDE.md — GradeDex EU

Sports card grading app. Users fotograferer kort, OCR + Claude API analyserer dem, Supabase gemmer data. PWA til mobil brug.

## Tech Stack

- **Frontend**: React 18, Vite 5, JSX (ingen TypeScript i dette projekt)
- **Backend**: Vercel Edge Functions (`/api/` mappen)
- **Database + Auth**: Supabase (PostgreSQL + Supabase Auth)
- **Vision/Embedding**: `@huggingface/transformers` — CLIP-model i `src/recognition/EmbeddingExtractor.js`
- **AI**: Anthropic Claude API — kortanalyse i `api/analyze.js`
- **PWA**: `public/manifest.json` + `public/sw.js` (cleanup SW — ingen caching). `vite-plugin-pwa` er i devDeps men ikke konfigureret; intentionelt fjernet pga. cache-problemer.
- **Deployment**: Vercel (frontend + Edge Functions)

## Vigtige Filer

```
gradedex/
├── src/
│   ├── App.jsx                          # Hele appens UI og state (monolitisk komponent)
│   ├── main.jsx                         # React entry point
│   └── recognition/
│       ├── EmbeddingExtractor.js        # CLIP-model wrapper (@huggingface/transformers)
│       └── MultiFrameBuffer.js          # Multi-frame embedding buffer (reserveret til live-scan)
├── api/
│   ├── analyze.js       # Edge Function: Claude API kortanalyse + PTCG lookup
│   └── cardimage.js     # Edge Function: kortbillede hentning (pokemontcg.io, Scryfall, YGO)
├── public/
│   ├── manifest.json    # PWA manifest
│   ├── sw.js            # Cleanup service worker — clears old caches + self-destructs
│   └── logos/           # Game logos (SVG/PNG)
├── index.html           # App shell + HTML splash
├── vite.config.js       # Vite konfiguration (ingen PWA plugin)
└── vercel.json          # Vercel routing + security headers + CSP
```

## Environment Variables

```bash
# Frontend (Vercel + lokalt i .env.local)
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=

# Vercel Edge Functions (KUN server-side)
ANTHROPIC_API_KEY=        # Aldrig VITE_ prefix — kun server-side
SUPABASE_URL=
SUPABASE_SERVICE_KEY=     # Service role — aldrig til frontend
```

**Regel:** Alt med `VITE_` prefix er synligt i browseren. Secrets (API keys) skal aldrig have `VITE_` prefix — de hører kun i Edge Functions.

## Dev Commands

```bash
npm run dev       # Start Vite dev server (localhost:5173)
npm run build     # Byg til dist/
npm run preview   # Preview production build lokalt
```

## Kodestandarder (dette projekt)

**JSX, ikke TSX.** Projektet bruger ikke TypeScript. Tilføj ikke `.ts`/`.tsx` filer uden aftale.

**Komponentstruktur:**
- Al state og logik er pt. i `App.jsx` — dette er bevidst for et lille projekt
- Udpak kun til separate komponenter når en sektion er over ~100 linjer og logisk selvstændig
- Ingen state management bibliotek — React's `useState`/`useReducer` er tilstrækkeligt

**Supabase:**
- Frontend bruger `VITE_SUPABASE_ANON_KEY` med Supabase Auth JWT
- Edge Functions bruger `SUPABASE_SERVICE_KEY` — kun til server-side operationer
- RLS skal være aktiveret på alle tabeller

**Vercel Edge Functions (`/api/`):**
- `export const config = { runtime: 'edge' }` på alle functions
- Valider altid Supabase JWT token før data-adgang
- Brug `new Response(...)` ikke `res.json()` (Edge runtime, ikke Node.js)
- CORS headers på alle functions (se eksisterende pattern i analyze.js)

**PWA:**
- Service worker håndteres af vite-plugin-pwa — redigér kun i `vite.config.js`
- `manifest.json` ligger i `public/` — ikke auto-genereret
- Test offline-mode via DevTools → Application → Service Workers

**CSS:**
- Ingen Tailwind i dette projekt — ren CSS
- Styles er sandsynligvis inline eller i `<style>` tags i JSX
- Behold eksisterende CSS-mønster

## Supabase Supabase-ID

Projektet bruger Supabase-projektet `yezlcgooutpshqdhvufg` (synligt i CSP headers i vercel.json).

## Sikkerhed (vigtig)

- `ANTHROPIC_API_KEY` og `SUPABASE_SERVICE_KEY` må ALDRIG eksponeres til frontend
- JWT-validering sker i Edge Functions — tjek at mønsteret fra `api/analyze.js` følges i nye functions
- CSP headers i `vercel.json` er konfigureret — opdater dem hvis nye eksterne domæner tilføjes

## Deployment

Vercel auto-deployer fra `main` branch. Edge Functions i `/api/` deployeres automatisk. Environment variables sættes i Vercel dashboard (ikke committed til git).

## Kendte Mønstre

- Kortanalyse flow: Bruger → foto → crop → `api/analyze.js` (Claude) → PTCG lookup → Supabase gem
- Embedding flow (valgfri): `EmbeddingExtractor.js` (CLIP) → `/api/match` → pre-identified card → Claude kun grader kondition
- Auth flow: Supabase Auth JWT → valideret i hver Edge Function
- Debug panel: Vises kun i development (`import.meta.env.DEV`) — skjult i production

## Stripe

`STRIPE_URL` i App.jsx er en placeholder (`https://buy.stripe.com/REPLACE_WITH_YOUR_STRIPE_LINK`). Skal sættes til et rigtigt Stripe Payment Link inden launch.
