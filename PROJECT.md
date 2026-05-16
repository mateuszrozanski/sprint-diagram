# Sprint Room — knowledge base

Daily-share Gantt-style board dla zespołu Synergy POD pracującego na projekcie
**Mezzanine** w organizacji **pwc-us-tax-tech** (ADO Services).

**Live:** https://sprint-room.vercel.app
**Repo:** https://github.com/mateuszrozanski/sprint-diagram
**Author:** Mateusz Różański (Synergy Codes) — `mateusz.rozanski@synergycodes.com`

---

## 1. Co to robi

Pobiera bieżący sprint zespołu **Synergy POD** z Azure DevOps i renderuje go jako
swimlane diagram (jeden swimlane per developer) z kartami PBI/Task. Daje
zespołowi szybki ogląd na daily kto-co-kiedy.

Funkcjonalność:

- **Auto-fetch z ADO** — `@CurrentIteration('[Mezzanine]\Synergy POD')`, sam się
  rotuje gdy team backlog iteration się zmienia (zmiana sprintu).
- **Daty kalendarza** dynamicznie z ADO Iteration metadata (start/finish).
- **Tasks-level granularność** — każda karta to pojedynczy Task (z `RemainingWork > 0`),
  z parent PBI jako kontekst (w details panelu).
- **Carryover-aware** — PBI bez otwartych dev-tasków (review/QA) pokazuje się
  jako mały kafel 0.5d, nie zaśmieca kalendarza pełnym Effort.
- **QA sub-lanes per tester** — auto-discovered z `Custom.QATester`. Dedykowany
  tester (np. Alicja) wyklucza się z dev lane przez env `ADO_QA_TESTERS`.
- **Shared state** — wszyscy widzą ten sam stan (Upstash Redis). Drag/edit
  propaguje się do reszty zespołu (auto-save co 2s).
- **Click details panel** — obok karty, z linkiem **Open in ADO** i **Copy link**.
- **Modal-style close** — klik poza panelem zamyka.

---

## 2. Architektura

```
                   ┌──────────────────────────────────────┐
                   │  Browser (Angular 21 SPA)            │
                   │  ng-diagram + custom layout          │
                   └──────────────┬───────────────────────┘
                                  │ HTTPS (Basic Auth gated)
                                  ▼
                   ┌──────────────────────────────────────┐
                   │  middleware.ts (Vercel Routing       │
                   │  Middleware) — Basic Auth na CAŁY    │
                   │  ruch (HTML, JS, /api/*)             │
                   └──────────────┬───────────────────────┘
                                  │
                ┌─────────────────┼─────────────────┐
                ▼                 ▼                 ▼
       ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
       │ api/ado/     │  │ api/state.ts │  │ static SPA   │
       │ [...path].ts │  │ (Upstash)    │  │ (dist/)      │
       │ (proxy ADO)  │  │              │  │              │
       └──────┬───────┘  └──────┬───────┘  └──────────────┘
              │                  │
              ▼                  ▼
    ┌─────────────────┐  ┌──────────────┐
    │ dev.azure.com   │  │ Upstash Redis│
    │ /pwc-us-tax-tech│  │ KV via       │
    │ /Mezzanine      │  │ Marketplace  │
    └─────────────────┘  └──────────────┘
```

**Deploy:** Vercel project `sprint-diagram` (org `mateusz277-9550s-projects`).
Production alias `sprint-room.vercel.app`. Framework: Angular (auto-detect).

---

## 3. Auth model

**Cały portal za jednym hasłem** (Basic Auth):

| Komponent | Auth |
|---|---|
| `/*` (HTML, JS, CSS, /api/*) | **`middleware.ts`** sprawdza `Authorization: Basic` na każdym request. Bez creds → `401 + WWW-Authenticate` → przeglądarka pokazuje natywny popup. |
| `/api/ado/*` (proxy) | Dodatkowo sprawdza Basic Auth wewnątrz funkcji (defense in depth). |
| `/api/state` (Redis CRUD) | Tylko middleware — endpoint sam nie ma auth (pod middleware już sprawdzony). |

**Creds:** `DEMO_USER` / `DEMO_PASS` (env w Vercelu).

**ADO PAT:** trzymany jako `ADO_PAT` env w Vercelu, never w bundlu klienta.
Min scope: `Work Items: Read`. Generowany w `pwc-us-tax-tech` org, TTL 30 dni
(rotacja w kalendarzu).

**Vercel SSO Protection wyłączone** (`ssoProtection: null` na projekcie) —
wcześniej wymagało konta Vercel, było upierdliwe.

---

## 4. Env variables (Vercel project settings)

| Var | Default | Co to robi |
|---|---|---|
| `ADO_ORG` | `pwc-us-tax-tech` | Organization slug w ADO |
| `ADO_PROJECT` | `Mezzanine` | Projekt w ADO |
| `ADO_TEAM` | `Synergy POD` | Team — używany w `@CurrentIteration('[project]\team')` |
| `ADO_ITERATION` | *(empty)* | Konkretna iteracja `Mezzanine\PI-4\2026 Sprint 23` — jeśli puste, używamy `@CurrentIteration` |
| `ADO_AREA_PATH` | `Mezzanine\DataFlow\Non-Extraction\Synergy` | `[System.AreaPath] UNDER <ten>` w WIQL |
| `ADO_QA_TESTERS` | `Alicja Slodczyk-Czerniawska (US)` | Comma-separated display names — wykluczone z dev lane (przeniesione do QA sub-lane) |
| `ADO_PAT` | *(secret)* | Personal Access Token, scope Work Items: Read |
| `ADO_API_VERSION` | `7.1` | Wersja ADO REST API |
| `DEMO_USER` | `daily` | Login do Basic Auth |
| `DEMO_PASS` | *(strong random)* | Hasło Basic Auth — `openssl rand -base64 24` |
| `KV_REST_API_URL` | *(auto)* | Upstash REST URL — wpisany automatycznie przez Marketplace integration |
| `KV_REST_API_TOKEN` | *(auto)* | Upstash REST token (write) |
| `KV_REST_API_READ_ONLY_TOKEN` | *(auto)* | Upstash read-only token |
| `KV_URL` | *(auto)* | Standard Redis URL (Upstash provides for compat) |
| `REDIS_URL` | *(auto)* | Same |

Lokalne: `vercel env pull .env.local` ściąga snapshot do `.env.local` (w gitignore).

---

## 5. Kluczowe pliki

```
sprint-diagram/
├── middleware.ts                       # Vercel Routing Middleware — Basic Auth gate na cały ruch
├── vercel.json                         # framework: angular (reszta auto)
├── proxy.conf.json                     # ng serve → localhost:3333 (lokalny mock)
├── api/
│   ├── ado/[...path].ts                # Vercel Function: proxy do dev.azure.com + WIQL builder
│   └── state.ts                        # Vercel Function: GET/POST/DELETE shared state w Redis
├── ado-mock/                           # Lokalny mock serwer dla dev (Express)
│   ├── server.js                       # /api/ado/wiql, /api/ado/workitems — fake data
│   └── package.json                    # `npm start` → port 3333
├── scripts/
│   └── test-card-width.mjs             # standalone node test dla widthForHours()
├── src/app/
│   ├── app.component.ts                # Główny komponent: load/save state, position panel, drag, lanes
│   ├── app.component.html              # Topbar, diagram, details panel (poza diagram-area!)
│   ├── app.component.css               # Topbar + node-details-panel CSS
│   ├── ado.service.ts                  # fetchSprintItems(users): { pbis, users, testers, iteration }
│   ├── card-width.ts                   # widthForHours() — testowalna formuła
│   ├── layout.ts                       # L.{DAY_W, ROW_H, NODE_H, ...} + position helpers
│   ├── sprint-data.ts                  # AdoPbi/SprintUser interfaces, mutable CALENDAR_SLOTS + setSprintCalendar
│   ├── sprint-ado.ts                   # buildNodesFromAdo() — greedy schedule, topo sort
│   ├── sprint-data-store.service.ts    # signals: pbis, users, incomingBugs + setUsers() (persists)
│   ├── sprint-utils.ts                 # collision resolvers, qa sync
│   ├── sprint.service.ts               # liveAssignee, liveDeps, liveQaLinks, undo
│   ├── diagram-drag.service.ts         # drag-end handlers, drop-to-incoming
│   └── nodes/
│       ├── pbi-node.{ts,html,css}      # PBI card render (ID + hours badge + role + avatar + title)
│       ├── qa-task.{ts,html,css}       # QA card per PBI (tester name visible)
│       ├── swimlane.{ts,html,css}      # Header + lane rows + day grid
│       └── dep-edge.{ts,html}          # Dependency arrows
```

---

## 6. ADO data flow

### 6.1. Pobieranie

`AdoService.fetchSprintItems([])`:

1. **Parallel:**
   - `GET /api/ado/iteration` → current iteration metadata (name, startDate, finishDate, qaTesters)
   - `POST /api/ado/wiql` → lista ID PBI/Bugów w sprincie (server-built query)

2. Server WIQL (api/ado/[...path].ts → buildSprintWiql):
   ```sql
   SELECT [System.Id] FROM WorkItems
   WHERE [System.TeamProject] = 'Mezzanine'
     AND [System.WorkItemType] IN ('User Story','Product Backlog Item','Bug')
     AND [System.State] <> 'Closed'
     AND [System.IterationPath] = @CurrentIteration('[Mezzanine]\Synergy POD')
     AND [System.AreaPath] UNDER 'Mezzanine\DataFlow\Non-Extraction\Synergy'
   ```

3. **`GET /api/ado/workitems?ids=...&$expand=relations`** — pobiera PBI z relationships.

4. **Drugi batch fetch** — zbiera ID dziecek-tasków z `Hierarchy-Forward` relations
   i pobiera je też. Filtruje tylko `Task` typu z `RemainingWork > 0`.

5. **Mapping PBI → AdoPbi:**
   - **Phases per Task:** każdy otwarty Task = osobna faza.
     - `assigneeId` = slugified display name z `System.AssignedTo`
     - `hours` = `Microsoft.VSTS.Scheduling.RemainingWork`
     - `days` = `hoursToDays(hours)` — 0.5d granularity dla layoutu
     - `title` = task title
   - **Brak otwartych dev-tasków** (carryover w code review/QA): jedna faza 0.5d z PBI assignee.
   - **QA tester** = `Custom.QATester.displayName` — slugified jako `qa-...`, używane w QA sub-lanes.
   - **Dependencies** = `System.LinkTypes.Dependency-Reverse` (predecessors).

### 6.2. Discovery userów/testerów

- **Dev userzy** — wszyscy unikalni `System.AssignedTo` na tasksach. Slug ID:
  `Mateusz Rozanski (US)` → `mateusz-rozanski-us`.
- **QA testerzy** — wszyscy unikalni `Custom.QATester` na PBI. Slug ID: `qa-{slug}`.
- **Dedykowany QA (env ADO_QA_TESTERS)** — nawet jeśli ma `System.AssignedTo` na
  jakimś PBI (np. test-automation work) → nie ląduje w dev lane.

### 6.3. Layout (sprint-ado.ts buildNodesFromAdo)

Greedy scheduler:

1. **`topoSort(items)`** — PBI z `dependsOn` idą za dependencami. W tej samej
   warstwie topo: bugi pierwsze, potem priority asc (1 = najwyższy).
2. Dla każdej fazy: `startDay = max(devCursor[assignee], prevChainEnd)`.
3. `endDay = computeEndDay(startDay, days)` — pomija holidays z `HOLIDAYS` set.
4. Cross-PBI dependency: pierwsza faza zależnego PBI startuje po ostatniej fazie
   dependa.
5. **Wizualna szerokość** karty z `widthForHours()` w `card-width.ts` —
   proporcjonalna do `RemainingWork` (60px/h, min 120, max 3000):
   - 1h ≤ 120px (min)
   - 3h → 180px
   - 6h → 360px ≈ 1 dzień (DAY_W = 340)
   - 12h → 720px ≈ 2 dni

---

## 7. Persistence — Upstash Redis

**Klucz:** `sprint-board:current`. Wartość: JSON snapshot diagramu.

**Auto-save:** co 2 sekundy w `app.component.ts` → `saveStateToServer()`:
- Stringify state, porównaj z `lastSavedJson`, POST jeśli zmieniło się.

**Restore:** w `ngAfterViewInit` → `restoreFromServer()`:
- `GET /api/state` → JSON → odbuduj swimlanes, kalendarz, nodes, edges.

**Co siedzi w state:**
```json
{
  "version": 1,
  "updatedAt": "2026-05-15T...",
  "users": [...],
  "testers": [...],
  "sprint": {
    "startISO": "2026-05-04",
    "days": 10,
    "iteration": { "name": "2026 Sprint 24", "startDate": "...", "finishDate": "..." }
  },
  "nodes": [...],   // wszystkie diagram nodes (PBI, QA, swimlanes)
  "edges": [...]    // wszystkie edges (dep, handoff, qa)
}
```

**Konflikty:** last-write-wins (akceptowalne dla daily, brak CRDT).

**Reset:** `resetDiagram()` w app component woła `DELETE /api/state` — czyści
shared state, kolejny load od zera.

---

## 8. UI — szczegóły

### 8.1. Karta PBI/Task

W górnym rzędzie: **ID** (kolor parent PBI) + ewentualny **BUG badge** + **hours
badge** (pomarańczowy "4h") + **role badge** (Dev) + **avatar**. Pod spodem
**tytuł taska** (4-8 linii clamp, font 11-13px). Z prawej **dependency marker**
(`↤ 2`) jeśli są deps.

**Co NIE jest na karcie** (przeniesione do details panel):
- Parent PBI title
- Daty start/end
- Tester name

### 8.2. Details panel

Po kliknięciu karty pojawia się **obok** (prawo, jak nie ma miejsca → lewo,
jak też nie → poniżej). Trzyma się aż:
- Klik **×** w panelu
- Klik w **inną kartę** → switchuje na nową
- Klik **poza panelem i poza kartą** → zamyka (modal-style)

Zawartość:
- Header: ID, badges (BUG/hours/role lub QA)
- Tytuł taska (duży)
- Parent PBI title
- Assignee + zakres dni
- **↗ Open in ADO** (link do `dev.azure.com/.../workitems/edit/{id}`)
- **⧉ Copy link** (clipboard API)
- Zwijany sekretór "Edit" (title + color)

**Bug fix history:** panel renderuje się **poza** `<div class="diagram-area">`
(na poziomie `<div class="app-shell">`), żeby `position: fixed` nie był psuty
przez `transform` na ng-diagram parencie. Dlatego ten szczególny układ DOM.

### 8.3. Swimlanes

Pionowe rzędy:
- **Header** (D1..D10 dni kalendarza + nazwa sprintu w left corner)
- **Incoming** — pusty rząd na parkowanie kart (drag-to-incoming z dev lane)
- **N × dev rows** — jeden per developer z ADO
- **M × QA rows** — jeden per tester z `Custom.QATester` (np. Alicja, Damian)

**Drag-to-incoming** dla dowolnej karty — set `liveAssignee=unassigned`, snap Y
do incoming row. Z incoming można drag back do dev row (`handleIncomingBugDrop`).

### 8.4. Edges (linie)

`zOrder: 5` (pod kartami). Karty `zOrder: 10`. Linie zachowują widoczność między
kartami ale nie zasłaniają tytułu kiedy przechodzą przez kartę.

Typy edges:
- **handoff** (PBI internal phase chain) — kolor parent PBI
- **dep** (cross-PBI dependency) — `dep-edge.component`
- **qa** (PBI → QA card)

---

## 9. Constants — czego dotykać żeby tunować

`src/app/layout.ts`:
```ts
HEADER_H: 68     // header height (top bar)
LABEL_W:  160    // left lane label column width
ROW_H:    200    // lane row height
DAY_W:    340    // jeden dzień sprintu w px
WKND_W:   80     // weekend column width
NODE_H:   160    // card height
PAD:      6      // padding w karcie
```

`src/app/card-width.ts`:
```ts
MIN_WIDTH:    120  // minimum card width
PX_PER_HOUR:  60   // = DAY_W / 6h roboczych — 6h task ≈ 1 dzień
MAX_WIDTH:    3000 // cap dla super-long tasków
```

`src/app/sprint-data.ts`:
```ts
SPRINT_DAYS = 10   // dynamicznie nadpisywane przez setSprintCalendar()
SPRINT_START       // Date — mutated in place przez setSprintCalendar()
```

---

## 10. Dev workflow

### 10.1. Lokalnie

```bash
# Terminal 1: mock ADO server
cd ado-mock && npm start          # localhost:3333

# Terminal 2: Angular dev
npm start                          # localhost:4200 (proxy /api/* → 3333)
```

Mock zwraca te same shape co real ADO, ale z fake data (Alice/Bob/Carol/David).

### 10.2. Test (unit)

```bash
node scripts/test-card-width.mjs   # 10 cases, sprawdza widthForHours()
```

Standalone — bez Karma/Jest. Jak zmienisz proporcje w `card-width.ts`,
zsynchronizuj stałe w skrypcie i odpal `node ...mjs` — wyświetla tabelę.

### 10.3. Deploy

```bash
vercel deploy --prod                                # nowy deploy
vercel alias set <url> sprint-room.vercel.app      # przepnij ładny URL
```

Albo skrypt one-liner:
```bash
D=$(vercel deploy --prod 2>&1 | grep '"url"' | head -1 | sed -E 's/.*"(https:[^"]+)".*/\1/')
vercel alias set "$D" sprint-room.vercel.app
```

### 10.4. Vercel env management

```bash
vercel env ls                              # zobacz wszystkie
vercel env add NAME production             # interaktywne (wpisujesz w prompcie)
printf 'value' | vercel env add NAME production    # z stdin
vercel env add NAME preview --value 'x' --yes      # non-interactive
vercel env rm NAME production              # delete
vercel env pull .env.local                 # pull do pliku
```

### 10.5. Czyszczenie Redis state

```bash
# Z lokalu (.env.local musi być pobrane)
URL=$(grep "KV_REST_API_URL" .env.local | cut -d'"' -f2)
TOKEN=$(grep "KV_REST_API_TOKEN=" .env.local | cut -d'"' -f2)
curl -s -X POST "$URL/del/sprint-board:current" -H "Authorization: Bearer $TOKEN"
```

Albo z UI: kliknij **↺ Reset** w topbarze.

---

## 11. Nowy sprint — checklist

1. **Po stronie ADO**: project admin ustawia nową iterację jako bieżącą dla
   team backlog "Synergy POD" (Project Settings → Team Configuration → Iterations).
2. **W apce**: kliknij **↺ Reset** → **🔄 Reload from ADO** → wpisz hasło.
3. Apka automatycznie:
   - Pobiera iteration metadata (name, dates) → aktualizuje header kalendarza
   - Pobiera PBI w nowej iteracji + zliczyła area path
   - Auto-discovery nowych userów/testerów z task assignees
   - Czysty state w Redis (po Reset)

**Co manualnie aktualizować tylko gdy:**
- Doszedł nowy dedykowany QA tester → `vercel env add ADO_QA_TESTERS production` (lista comma-separated)
- PAT wygasł (30 dni) → wygeneruj nowy, `vercel env rm ADO_PAT production` + add świeży

---

## 12. Historia decyzji (krótka)

| Data | Decyzja | Powód |
|---|---|---|
| 2026-04 | Angular SPA + ng-diagram | Starter, ng-diagram daje swimlane layout |
| 2026-04 | ADO mock w Express | Iterować bez prawdziwego ADO |
| 2026-05-13 | Vercel Function jako proxy ADO | CORS + PAT not in bundle |
| 2026-05-13 | Basic Auth (DEMO_USER/PASS) zamiast MS SSO | MS SSO wymagałby App Registration w Synergy Entra (czekanie na IT) |
| 2026-05-13 | Min-width tasków → variable scaling | Wszystkie taski PWC są 1-3h → wszystkie wyglądały tak samo |
| 2026-05-13 | Hours badge na karcie | Width nie wystarcza do różnicowania krótkich tasków |
| 2026-05-13 | Upstash Redis dla shared state | Vercel Marketplace, free tier, prostsze niż Neon |
| 2026-05-13 | `widthForHours()` w `card-width.ts` + unit test | Jedna formuła do tunowania, testowalna |
| 2026-05-13 | NODE_H = 200 + line-clamp 8 | Worst-case długie tytuły (np. "[K1 Kapture] [Expected Document] Actual Received Date...") |
| 2026-05-13 | Details panel zamiast meta na karcie | Mniejszy clutter, więcej miejsca na title |
| 2026-05-13 | Panel zostaje aż outside-click | Modal-style, user-friendly |
| 2026-05-13 | Sub-lane QA per tester | Damian czasem testuje, Alicja zawsze — multi-tester view |
| 2026-05-13 | Drop manualne narzędzia (+ PBI, + QA, Simulate bug) | ADO source of truth, no manual creation |
| 2026-05-13 | Vercel SSO Protection wyłączone | Wymagało konta Vercel — upierdliwe dla teamu |
| 2026-05-13 | `sprint-room.vercel.app` claimed | Ładny alias dla daily-share |
| 2026-05-15 | Sprint name w topbar + corner | Z `iteration.name` ADO |

---

## 13. Znane ograniczenia

- **Last-write-wins** przy równoczesnej edycji. Brak CRDT/operational transform.
  Dla daily akceptowalne (mówicie sobie kto co rusza).
- **Variable card heights** nie zaimplementowane — wszystkie karty mają NODE_H=200,
  krótkie tytuły mają sporo pustego miejsca. Refactor wymagałby per-row max-height.
- **Sprint scheduler** ignoruje dependencies między różnymi developmentami w
  tym samym czasie (sequential per-dev cursor, ale nie reszedu globalnie).
- **PAT 30-dniowy** — wymaga manualnej rotacji. Brak automation.
- **Pojedynczy board** — klucz `sprint-board:current`. Per-sprint historia
  nie jest trzymana.
- **Brak audit log** — nie wiemy kto przesunął kartę.

---

## 14. Pomysły na rozszerzenia (future work)

- Per-sprint klucze w Redis (`sprint-board:{sprintName}`) — historia retrospektyw.
- Drag preview pokazujący timeline impact.
- Notifikacje Slack/Teams gdy sprint plan się zmienia.
- Burndown chart obok kalendarza.
- Per-user filter ("pokaż tylko moje karty").
- Comments na karcie (ad-hoc, nie z ADO).
- Real-time sync przez WebSocket zamiast 2s polling.
- Variable card heights (per-card height based on title length, ROW_H = max in row).
- MS SSO jak Synergy Entra App Registration zostanie założony — replace Basic Auth.

---

## 15. Diagnostyka problemów

### 15.1. "Karta nie chce się odznaczać"

**Objaw:** klik w kartę pokazuje panel, klik w nią ponownie — nic.
**Root cause:** ng-diagram trzyma własny stan selekcji. Trzeba też `selectionService.deselectAll()`.
**Fix:** już w `closeDetails()` w `app.component.ts`.

### 15.2. "Panel pojawia się w lewym górnym rogu"

**Objaw:** flash panelu w `(16, 80)` przy zmianie selekcji.
**Root cause:** `detailsPanelPos` jest null gdy `selectedNode` już ustawiony,
fallback w template renderuje przy `(0, 0)` lub `(16, 80)`.
**Fix:** CSS `.hidden-until-positioned { visibility: hidden }` + reset
`detailsPanelPos = null` na początku każdej selekcji.

### 15.3. "Karty wszystkie tej samej szerokości"

**Objaw:** wszystkie karty wyglądają identycznie.
**Root cause:** większość PWC tasków ma `RemainingWork ≤ 3h` → `hoursToDays`
rounduje wszystko do 0.5d → wszystko hits min-width.
**Fix:** szerokość bezpośrednio z hours w `widthForHours()`, omijając
half-day rounding. Min 120px (czytelność), 60px/h proporcjonalność.

### 15.4. "Tytuł karty ucięty"

**Objaw:** "[K1 Kapture] [Expected Document]..." cut po 3 liniach.
**Root cause:** NODE_H za małe + line-clamp za niskie.
**Fix:** NODE_H = 200, line-clamp = 8 (CSS w `pbi-node.component.css`).

### 15.5. "Daty kalendarza nie pasują"

**Objaw:** header pokazuje stary sprint.
**Root cause:** `SPRINT_START` zahardkodowany 2026-04-06.
**Fix:** `setSprintCalendar()` woła się w `loadFromAdo` z dat ADO iteration.
Jeśli ADO `iteration.startDate`/`finishDate` puste — fallback do hardkodu.
Sprawdź czy team backlog ma ustawione daty iteracji.

### 15.6. "Linia przechodzi przez kartę i zasłania tekst"

**Fix:** edges `zOrder: 5`, nodes `zOrder: 10` — karty zawsze nad liniami.

### 15.7. "ng-diagram zoom-to-fit kompresuje wszystko"

**Objaw:** karty wyglądają na 1/3 oczekiwanej szerokości.
**Root cause:** `(diagramInit)="fitView()"` w `app.component.html` —
wymuszał zoom-to-fit przy każdym init.
**Fix:** wywalone z template. Auto-fit tylko po manualnym kliknięciu
"Fit to view".

---

## 16. Komendy dyspozycyjne

```bash
# Lokalnie
npm start                                              # ng serve, port 4200
cd ado-mock && npm start                              # mock ADO server, port 3333
npm run build                                         # production build → dist/
node scripts/test-card-width.mjs                      # unit test width formula

# Vercel
vercel env ls
vercel deploy --prod
vercel alias set <new-deploy-url> sprint-room.vercel.app
vercel logs --environment production --since 10m --no-branch --expand
vercel logs --environment production --status-code 500 --no-branch --json

# Redis (lokalnie po vercel env pull .env.local)
URL=$(grep "KV_REST_API_URL" .env.local | cut -d'"' -f2)
TOKEN=$(grep "KV_REST_API_TOKEN=" .env.local | cut -d'"' -f2)
curl -s "$URL/get/sprint-board:current" -H "Authorization: Bearer $TOKEN"   # read
curl -s -X POST "$URL/del/sprint-board:current" -H "Authorization: Bearer $TOKEN"   # delete

# Git
git log --oneline -20
git status --short
```

---

*Last update: 2026-05-16. Plik utrzymywany przez Mateusza + Claude Code.*
