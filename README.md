# Dyrkeboka – Tveitan

Dyrkeverktøy for småbruket ved Frebergsvik: årshjul og ukeoppgaver, såkalender for rundt 75 vekster, bedplan med vekstskifte, drivhus, kirsebærhage med 40 trær og dagbok. I tillegg kommer frostvarsel fra Meteorologisk institutt, felles lagring for hele familien og (valgfritt) «Spør om gården» via Claude.

Alt kjører som én Cloudflare Worker: den serverer appen, lagrer data i D1 og henter været.

```
dyrkeboka/
├─ public/                 appen (statiske filer)
│  ├─ index.html           hele appen – HTML, CSS og JS i én fil
│  ├─ sw.js                service worker – appen virker uten nett
│  ├─ manifest.webmanifest kan legges på hjemskjermen som en app
│  └─ icon*.png, icon.svg, apple-touch-icon.png
├─ src/worker.js           API: lagring (D1), vær (MET), AI (Claude)
├─ wrangler.toml           oppsett for Cloudflare
└─ package.json
```

## Kom i gang

Databasen (D1) opprettes automatisk første gang Cloudflare deployer, så det er ikke noe å lime inn.

### A. Fra et Git-repo (anbefalt – deploy ved hver push)

1. **Legg koden i repoet.** Det kan ligge på GitHub eller i Cloudflare Artifacts. For Artifacts fra PC-en:
   ```bash
   cd dyrkeboka
   git init -b main && git add . && git commit -m "Dyrkeboka"
   git remote add origin https://<KONTO-ID>.artifacts.cloudflare.net/git/<namespace>/dyrkeboka.git
   git -c http.extraHeader="Authorization: Bearer <SKRIVETOKEN>" push -u origin main
   ```
2. **Koble repoet til Cloudflare:** Workers & Pages → Create application → velg Artifacts eller GitHub → velg repoet → Deploy. Workeren må hete `dyrkeboka`, som i `wrangler.toml`.
3. **Sett familiekoden:** Workeren → Settings → Variables and Secrets → Add → type *Secret*, navn `FAMILY_KEY`. Gjør det samme med `ANTHROPIC_API_KEY` hvis du vil ha «Spør om gården».

### B. Fra kommandolinjen

```bash
npm install
npx wrangler login
npx wrangler secret put FAMILY_KEY
npx wrangler secret put ANTHROPIC_API_KEY   # valgfritt
npx wrangler deploy
```

Etter deploy får du en adresse som `https://dyrkeboka.<konto>.workers.dev`. Tabellene i databasen lages automatisk første gang appen brukes.

### Før du publiserer

- **Gårdens posisjon:** Sett `LAT`, `LON` og `ALT` i `wrangler.toml` til nøyaktig punkt (høyreklikk på norgeskart.no). Standardverdiene er et anslag for Frebergsvik.
- **MET krever identifikasjon:** Sett `MET_UA` til appnavn pluss nettside eller e-post. Varselet bufres i 30 minutter, slik MET ber om.
- **AI-modell:** `AI_MODEL` er `claude-sonnet-5-5`. Bytt til `claude-haiku-5-5` for lavere kostnad.

### Eget domene (dyrk.jortech.no)

Domenet må ligge som sone i Cloudflare, det vil si at navnetjenerne hos Webhuset peker til Cloudflare. Fjern da `#` foran `routes` i `wrangler.toml` og kjør `npx wrangler deploy` på nytt. Cloudflare lager DNS-oppføring og sertifikat selv.

## Bruk

1. Åpne adressen på telefonen.
2. Trykk på tannhjulet og skriv inn familiekoden.
3. Legg appen på hjemskjermen. iPhone: Del → «Legg til på Hjem-skjerm». Android: menyen → «Installer app».

Alle som har koden, ser og endrer den samme planen, de samme trærne og den samme loggen. Uten nett lagres endringene på telefonen og sendes når nettet er tilbake.

## Lokal utvikling

```bash
cp .dev.vars.example .dev.vars   # sett FAMILY_KEY
npx wrangler dev                 # http://localhost:8787
```

Lokalt bruker wrangler en egen SQLite-fil for D1, så ingenting går mot produksjonsdatabasen.

## API

| Metode | Sti | Kode | Hva |
|---|---|---|---|
| GET | `/api/info` | nei | Hva serveren støtter (kode, AI) |
| GET | `/api/vaer` | nei | Forenklet varsel: døgn med min, maks, nattemin, nedbør og symbol |
| GET/PUT | `/api/state` | ja | Hele planen (bed, trær, oppgaver, oppsett). Eldre versjoner avvises. |
| GET | `/api/logg?since=ms` | ja | Loggendringer siden et tidspunkt, også slettinger |
| PUT/DELETE | `/api/logg/:id` | ja | Lagre eller slette ett notat |
| POST | `/api/spor` | ja | Spørsmål til Claude (krever `ANTHROPIC_API_KEY`) |

## Sikkerhet

- **Familiekoden** sendes som `Authorization: Bearer` og sjekkes på serveren. Den holder fremmede ute, men er ikke brukerkontoer.
- **Strengere tilgang:** Legg Cloudflare Access (Zero Trust) foran domenet og gi tilgang per e-postadresse.
- **Sikkerhetskopi:** Under tannhjulet kan du laste ned alt som én JSON-fil og gjenopprette det senere.

## Kilder

Værdata fra Meteorologisk institutt (api.met.no, CC BY 4.0). Rådene om kirsebær bygger blant annet på Mattilsynet (bakteriekreft) og Store norske leksikon (kirsebærflue). Frostdatoene er anslag for kyst-Vestfold og kan justeres i appen.
