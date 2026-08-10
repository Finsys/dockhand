# OpenAPI annotation standard

This document is the binding reference for the `@openapi` JSDoc mini-DSL that Dockhand uses to
generate its REST API spec from the route tree (`scripts/openapi/lib.ts`,
`npm run generate:openapi`). It complements the "API documentation" section in `CONTRIBUTING.md`.

All examples and rules below are verified against the actual parser
(`scripts/openapi/lib.ts`) — line numbers refer to the state as of this commit.

## 1. Grammar reference table

An `@openapi` block is a `/** ... */` JSDoc comment directly above
`export const GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD:` (recognized by `ANNOTATION_BLOCK_RE`,
`scripts/openapi/lib.ts:314-315`). Each line inside the block is parsed individually
(`parseAnnotations`, `scripts/openapi/lib.ts:325-406`); the leading `* ` is stripped, and blank
lines plus the `@openapi` marker line itself are skipped (`lib.ts:331-334`).

| Key | Meaning | Example | Reference (line) |
|---|---|---|---|
| `summary` | One-line summary of the operation | `summary: List the authenticated user's API tokens` | `lib.ts:345-348` |
| `description` | Longer prose explanation (**exactly one line** — the parser is line-based, see Section 2) | `description: Reads and parses a single .env file (read-only).` | `lib.ts:349-352` |
| `query: <name>:<type>[!] <desc>` | Query parameter, repeatable | `query: env:integer Environment id — omitted returns all` | `lib.ts:353-364` |
| `path: <name>:<type>[!] <desc>` | Path parameter, repeatable; enriches an auto-detected `{name}` segment | `path: id:integer! Token id (from GET /api/auth/tokens)` | `lib.ts:353-364` |
| `body: <mini-schema>` | Request body as a mini-schema (object/array/scalar) | `body: {stackName:string!, environmentId:integer}` | `lib.ts:365-368` |
| `body-example: <json>` | Example payload for the body, **must be valid JSON** | `body-example: {"stackName":"immich","environmentId":2}` | `lib.ts:369-376` |
| `resp-<code>: <mini-schema>` **or** `resp-<code>: <text>` | Response schema or plain-text description for a status code | `resp-200: array<{id:integer!, name:string!}>` / `resp-403: Permission denied` | `lib.ts:377-393` |
| `resp-<code>-desc: <text>` | Overrides/sets the description of an already-declared `resp-<code>` | `resp-200-desc: Final result of an SSE job stream when deployNow:true.` | `lib.ts:396-397` |
| `resp-<code>-example: <json>` | Example payload for a status code, **must be valid JSON** | `resp-200-example: {"id":7,"stackName":"immich"}` | `lib.ts:399-400` |

**Type notation** (applies to `query`, `path`, `body`, response schemas):

- Scalar: `string` \| `integer` \| `number` \| `boolean`
- Array: `array<type>` (e.g. `array<{id:integer!, name:string!}>`)
- Object: `{field:type,field2:type2!,…}` — comma-separated, `!` directly after the type marks the
  field as `required`
- An unrecognized type word **silently** falls back to `string`
  (`parseMiniSchema`, `lib.ts:228-231`) — no error, no warning.

**Mini-schema grammar** (verbatim from the source-code comment, `lib.ts:207`):

```
mini-schema := 'string'|'integer'|'number'|'boolean' | '{' (name':'type'!'?','?)* '}' | 'array<' type '>'
```

## 2. Mandatory rules

1. **Body-carrying operations** (`POST`/`PUT`/`PATCH` with a payload): field names in `body:`
   must match what the handler actually reads from the payload, including `!` for required
   fields. The drift check (`npm run generate:openapi:check`, see `CONTRIBUTING.md`) compares
   this against a best-effort static analysis of the handler code (`analyzeHandlerBody`,
   `lib.ts:475-518`) — but it never replaces actually reading the handler; the static analysis
   is deliberately conservative (more false negatives than false positives, `lib.ts:409-414`).
2. **`summary`/`description`/`resp-<code>` must be verified against the real handler** — the
   handler code is ground truth, not a guess or a copy-paste from a similar endpoint.
3. **`description` is exactly ONE line.** The parser splits the comment block line by line
   (`blockBody.split('\n')`, `lib.ts:332`) and matches exactly one `key: value` pair per line
   (`lib.ts:341`). Markdown syntax (links, inline code) within that single line is allowed and
   is interpreted by the renderer (see Section 4) — a literal line break **inside** the value is
   not possible; anything after the first `\n` already belongs to the next `key: value` line, or
   is discarded if it doesn't match a known key.
4. **Examples (`body-example`, `resp-<code>-example`) must be valid JSON.** A malformed JSON
   literal is **silently dropped** (`try { JSON.parse(...) } catch { /* ignore malformed
   example */ }`, `lib.ts:369-376` and `lib.ts:381-386`) — no error message appears, the example
   simply ends up missing from the generated spec.
5. **Unknown keys are silently discarded — there is no `else` branch that warns.** A line that
   doesn't match the generic `key: value` pattern (`lib.ts:341`) is skipped entirely
   (`if (!kv) continue;`, `lib.ts:342-343`). A line with a recognized `key:`-looking prefix that
   doesn't match any of the handled cases (no `resp-<code>` pattern etc.) simply falls through
   the end of the condition chain and nothing happens (`lib.ts:377-393`, no closing `else`). A
   typo in the key (e.g. `respons-200` instead of `resp-200`) produces **no build error** — the
   information is just missing from the generated spec afterwards.

## 3. Cross-reference convention (BINDING)

When a parameter or body field references an ID that comes from another endpoint (e.g. an
`environmentId` you learn from `GET /api/environments`), document it **exactly** like this:

**For `path` and `query` parameters:** append it directly to the parameter description —

```
path: id:integer! Git stack ID (from GET /api/git/stacks)
```

Already used in the codebase: `src/routes/api/auth/tokens/[id]/+server.ts`
(`path: id:integer! Token id (from GET /api/auth/tokens)`).

**For body fields:** put it in the operation-wide `description` prose, with the same pattern —

```
description: environmentId from GET /api/environments.
```

**Why two different places:** `path` and `query` parameters have their own description slot in
the grammar (the `<desc>` after `<name>:<type>[!]`, see the table in Section 1). **Body fields
don't have that slot** — a `body:` mini-schema only knows field name, type, and `!`, no per-field
description (`parseMiniSchema`, `lib.ts:209-268`, the grammar has no description position). The
only place for body-field prose is the operation-wide `description` line — which is why the
cross-reference goes there, even when it refers to just one field.

The exact wording `<field> from <METHOD> /api/<path>` is a **string contract**: the MCP
derivation tool that generates MCP tool descriptions from the generated OpenAPI spec parses
exactly this pattern. Different phrasings (`see GET /api/...`, `cf. .../...`, `comes from ...`)
are not recognized by that tool.

## 4. Renderer notes

Dockhand exposes the same, byte-identically generated `openapi.json` (`GET /api/docs`) through
one of two possible viewers — Swagger UI (`feat/openapi-refresh`) or Scalar
(`feat/openapi-scalar`), under `GET /api/docs/ui`. For annotation authors, the following is
relevant:

- **Neither renderer displays `x-*` vendor extensions.** This is the standard behaviour of both
  libraries; it has not been verified against the bundled assets in this repo. Anything a human
  needs to see in the API docs should go through `summary`, `description`, or a parameter
  description — don't rely on hiding extra information in a vendor extension in the assumption
  that it will be rendered somewhere.
- **Markdown in `description` is interpreted by both renderers** — links
  (`[text](https://…)`), inline code (`` `value` ``) and simple emphasis are usable and are
  actually displayed as such, not as raw text.
- **Malformed JSON examples disappear silently** (see Section 2, item 4) — the same for both
  renderers: no example in the UI, no error message during generation.
- Scalar additionally generates multi-language code samples (curl, JavaScript, Python, …)
  automatically from path/method/body schema — this is purely renderer-side and requires no
  extra annotation.

## 5. Scalar as the preferred choice

Of the two renderer PRs prepared in parallel (`feat/openapi-refresh` → Swagger UI,
`feat/openapi-scalar` → Scalar), **Scalar is the preferred choice**, pending a maintainer
decision:

- Scalar renders the enriched `description` text, including Markdown links and the
  cross-references from Section 3, more readably than Swagger UI.
- Scalar generates multi-language code samples automatically from path, method and body schema
  without requiring any extra annotation.

Until a decision is made, **both PRs are treated as equivalent** — this annotation standard
applies identically to both, regardless of which renderer ends up being merged.
