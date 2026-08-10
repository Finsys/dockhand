# OpenAPI-Annotation-Standard

Dieses Dokument ist die verbindliche Referenz für die `@openapi`-JSDoc-Mini-DSL, mit der Dockhand
seine REST-API-Spezifikation aus dem Routenbaum generiert (`scripts/openapi/lib.ts`,
`npm run generate:openapi`). Es ergänzt den Abschnitt „API documentation" in `CONTRIBUTING.md`.

Alle Beispiele und Regeln unten sind gegen den tatsächlichen Parser
(`scripts/openapi/lib.ts`) verifiziert — Zeilennummern beziehen sich auf den Stand dieses Commits.

## 1. Grammatik-Referenztabelle

Ein `@openapi`-Block ist ein `/** ... */`-JSDoc-Kommentar unmittelbar über
`export const GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD:` (erkannt durch `ANNOTATION_BLOCK_RE`,
`scripts/openapi/lib.ts:314-315`). Jede Zeile im Block wird einzeln geparst
(`parseAnnotations`, `scripts/openapi/lib.ts:325-406`); die führenden `* ` werden entfernt, leere
Zeilen und die `@openapi`-Markerzeile selbst werden übersprungen (`lib.ts:331-334`).

| Key | Bedeutung | Beispiel | Beleg (Zeile) |
|---|---|---|---|
| `summary` | Kurzbeschreibung der Operation (eine Zeile) | `summary: List the authenticated user's API tokens` | `lib.ts:345-348` |
| `description` | Längere Prosa-Erklärung (**genau eine Zeile** — der Parser ist zeilenbasiert, siehe Abschnitt 2) | `description: Reads and parses a single .env file (read-only).` | `lib.ts:349-352` |
| `query: <name>:<type>[!] <desc>` | Query-Parameter, wiederholbar | `query: env:integer Environment id — omitted returns all` | `lib.ts:353-364` |
| `path: <name>:<type>[!] <desc>` | Pfad-Parameter, wiederholbar; reichert ein automatisch erkanntes `{name}`-Segment an | `path: id:integer! Token id (from GET /api/auth/tokens)` | `lib.ts:353-364` |
| `body: <mini-schema>` | Request-Body als Mini-Schema (Objekt/Array/Skalar) | `body: {stackName:string!, environmentId:integer}` | `lib.ts:365-368` |
| `body-example: <json>` | Beispiel-Payload für den Body, **valides JSON** | `body-example: {"stackName":"immich","environmentId":2}` | `lib.ts:369-376` |
| `resp-<code>: <mini-schema>` **oder** `resp-<code>: <text>` | Response-Schema oder Klartext-Beschreibung für einen Statuscode | `resp-200: array<{id:integer!, name:string!}>` / `resp-403: Permission denied` | `lib.ts:377-393` |
| `resp-<code>-desc: <text>` | Überschreibt/ergänzt die Beschreibung eines bereits deklarierten `resp-<code>` | `resp-200-desc: Final result of an SSE job stream when deployNow:true.` | `lib.ts:396-397` |
| `resp-<code>-example: <json>` | Beispiel-Payload für einen Statuscode, **valides JSON** | `resp-200-example: {"id":7,"stackName":"immich"}` | `lib.ts:399-400` |

**Typ-Notation** (gilt für `query`, `path`, `body`, Response-Schemas):

- Skalar: `string` \| `integer` \| `number` \| `boolean`
- Array: `array<typ>` (z. B. `array<{id:integer!, name:string!}>`)
- Objekt: `{feld:typ,feld2:typ2!,…}` — Kommagetrennt, `!` direkt nach dem Typ markiert das Feld als
  `required`
- Ein nicht erkanntes Typ-Wort fällt **stillschweigend** auf `string` zurück
  (`parseMiniSchema`, `lib.ts:228-231`) — kein Fehler, keine Warnung.

**Mini-Schema-Grammatik** (wörtlich aus dem Quellcode-Kommentar, `lib.ts:207`):

```
mini-schema := 'string'|'integer'|'number'|'boolean' | '{' (name':'type'!'?','?)* '}' | 'array<' type '>'
```

## 2. Pflichtregeln

1. **Body-tragende Operationen** (`POST`/`PUT`/`PATCH` mit Payload): Feldnamen im `body:`
   müssen mit dem tatsächlich vom Handler gelesenen Payload übereinstimmen, inklusive `!` für
   Pflichtfelder. Der Drift-Check (`npm run generate:openapi:check`, siehe `CONTRIBUTING.md`)
   vergleicht das gegen eine Best-Effort-Statik-Analyse des Handler-Codes
   (`analyzeHandlerBody`, `lib.ts:475-518`) — er ersetzt aber nie den Blick in den Handler
   selbst, die Statik-Analyse ist bewusst konservativ (mehr falsche Negative als falsche
   Positive, `lib.ts:409-414`).
2. **`summary`/`description`/`resp-<code>` sind gegen den echten Handler zu verifizieren** —
   der Handler-Code ist die Ground-Truth, nicht eine Vermutung oder ein Copy-Paste aus einem
   ähnlichen Endpoint.
3. **`description` ist genau EINE Zeile.** Der Parser zerlegt den Kommentarblock zeilenweise
   (`blockBody.split('\n')`, `lib.ts:332`) und matcht pro Zeile genau ein `key: value`-Paar
   (`lib.ts:341`). Markdown-Syntax (Links, Inline-Code) innerhalb der einen Zeile ist erlaubt und
   wird vom Renderer interpretiert (siehe Abschnitt 4) — ein literaler Zeilenumbruch **innerhalb**
   des Werts ist nicht möglich; alles nach dem ersten `\n` gehört bereits zur nächsten
   `key: value`-Zeile oder wird verworfen, wenn es zu keinem bekannten Key passt.
4. **Beispiele (`body-example`, `resp-<code>-example`) müssen valides JSON sein.** Ein
   fehlerhaftes JSON-Literal wird **stillschweigend verworfen** (`try { JSON.parse(...) } catch
   { /* ignore malformed example */ }`, `lib.ts:369-376` bzw. `lib.ts:381-386`) — es erscheint
   keine Fehlermeldung, das Beispiel fehlt im generierten Spec einfach ersatzlos.
5. **Unbekannte Keys werden still verworfen — es gibt keinen `else`-Zweig, der warnt.** Eine
   Zeile, die nicht auf das generische `key: value`-Muster passt (`lib.ts:341`), wird komplett
   übersprungen (`if (!kv) continue;`, `lib.ts:342-343`). Eine Zeile mit einem erkannten
   `key:`-Präfix, der zu keinem der behandelten Fälle passt (kein `resp-<code>`-Muster o. Ä.),
   fällt am Ende der Bedingungskette einfach durch, ohne dass etwas passiert (`lib.ts:377-393`,
   kein abschließendes `else`). Ein Tippfehler im Key (z. B. `respons-200` statt `resp-200`)
   erzeugt **keinen Build-Fehler** — die Information fehlt danach einfach im generierten Spec.

## 3. Cross-Ref-Konvention (VERBINDLICH)

Referenziert ein Parameter oder Body-Feld eine ID, die von einem anderen Endpoint stammt
(z. B. eine `environmentId`, die man über `GET /api/environments` erfährt), wird das **exakt so**
dokumentiert:

**Für `path`- und `query`-Parameter:** direkt an die Parameter-Beschreibung anhängen —

```
path: id:integer! Git stack ID (from GET /api/git/stacks)
```

Bereits im Bestand belegt: `src/routes/api/auth/tokens/[id]/+server.ts`
(`path: id:integer! Token id (from GET /api/auth/tokens)`).

**Für Body-Felder:** in die operations-weite `description`-Prosa, mit demselben Muster —

```
description: environmentId from GET /api/environments.
```

**Warum zwei verschiedene Stellen:** `path`- und `query`-Parameter haben in der Grammatik einen
eigenen Beschreibungs-Slot (das `<desc>` nach `<name>:<type>[!]`, siehe Tabelle in Abschnitt 1).
**Body-Felder haben diesen Slot nicht** — ein `body:`-Mini-Schema kennt nur Feldname, Typ und
`!`, keine Pro-Feld-Beschreibung (`parseMiniSchema`, `lib.ts:209-268`, Grammatik hat keine
Beschreibungs-Position). Der einzige Ort für Body-Feld-Prosa ist die operations-weite
`description`-Zeile — deshalb wandert der Cross-Ref dort hinein, auch wenn er sich nur auf ein
einzelnes Feld bezieht.

Die exakte Schreibweise `<Feld> from <METHOD> /api/<pfad>` ist ein **String-Vertrag**: das
MCP-Ableitungswerkzeug, das aus dem generierten OpenAPI-Spec MCP-Tool-Beschreibungen ableitet,
parst genau dieses Muster. Abweichende Formulierungen (`siehe GET /api/...`, `vgl. .../...`,
`stammt aus ...`) werden von diesem Werkzeug nicht erkannt.

## 4. Renderer-Hinweise

Dockhand exponiert denselben, byte-identisch generierten `openapi.json` (`GET /api/docs`) über
zwei mögliche Viewer — Swagger UI (`feat/openapi-refresh`) oder Scalar
(`feat/openapi-scalar`), unter `GET /api/docs/ui`. Für Annotations-Autoren ist relevant:

- **Beide Renderer zeigen `x-*`-Vendor-Extensions NICHT an.** Alles, was ein Mensch beim Lesen
  der API-Doku sehen soll, muss über `summary`, `description` oder eine Parameter-Beschreibung
  laufen — keine Zusatzinformation in einer Vendor-Extension „verstecken" in der Annahme, sie
  würde irgendwo sichtbar gerendert.
- **Markdown in `description` wird von beiden Renderern interpretiert** — Links
  (`[Text](https://…)`), Inline-Code (`` `wert` ``) und einfache Hervorhebungen sind nutzbar und
  werden auch tatsächlich als solche dargestellt, nicht als Rohtext.
- **Malformed JSON-Beispiele verschwinden lautlos** (siehe Abschnitt 2, Punkt 4) — bei beiden
  Renderern gleichermaßen: kein Beispiel im UI, keine Fehlermeldung beim Generieren.
- Scalar erzeugt zusätzlich automatisch mehrsprachige Code-Samples (curl, JavaScript, Python,
  …) aus Pfad/Methode/Body-Schema — das ist rein renderer-seitig und erfordert keine
  zusätzliche Annotation.

## 5. Scalar als Favorit

Von den zwei parallel vorbereiteten Renderer-PRs (`feat/openapi-refresh` → Swagger UI,
`feat/openapi-scalar` → Scalar) ist **Scalar der Favorit**, bis eine Maintainer-Entscheidung
vorliegt:

- Scalar rendert den angereicherten `description`-Text inklusive Markdown-Links und die
  Cross-Refs aus Abschnitt 3 lesbarer als Swagger UI.
- Scalar erzeugt automatisch mehrsprachige Code-Samples aus Pfad, Methode und Body-Schema, ohne
  dass dafür etwas zusätzlich annotiert werden müsste.

Bis zur Entscheidung sind **beide PRs gleichwertig** zu behandeln — dieser Annotation-Standard
gilt identisch für beide, unabhängig davon, welcher Renderer am Ende gemerged wird.
