Dockhand welcomes all contributions so thank you for considering contributing!

## How to Contribute
1. Fork the repository on GitHub.
2. Clone your forked repository to your local machine.
3. Create a new branch for your feature or bug fix.
4. Make your changes and commit them with clear messages.
5. Push your changes to your forked repository.
6. Open a pull request against the main repository's main branch.

## Tech Stack

- Base: own OS layer built from scratch using [Wolfi packages](https://github.com/wolfi-dev/os) via apko. Every package is explicitly declared in the Dockerfile.
- Frontend: [SvelteKit 2](https://svelte.dev/docs/kit/introduction), [Svelte 5](https://svelte.dev), [shadcn-svelte](https://www.shadcn-svelte.com), [TailwindCSS](https://tailwindcss.com)
- Backend: [Bun](https://bun.sh/) runtime with SvelteKit API routes
- Database: SQLite or PostgreSQL via [Drizzle ORM](https://orm.drizzle.team)
- Docker: direct docker API calls.

## Getting Started

1. Ensure you have Bun installed. You can download it from [Bun's official website](https://bun.sh/).
2. Clone the repository (or your fork):
   ```bash
   git clone https://github.com/your-username/dockhand.git
   cd dockhand
   ```
3. Install dependencies using Bun:
   ```bash
   bun install
   ```
4. Start the development server:
   ```bash
   bun dev
   ```
5. Open your browser and navigate to `http://localhost:5173` (or the port specified in the Bun output) to see the application running.

## API documentation

The REST API documentation (`GET /api/docs` for the JSON spec, `GET /api/docs/ui` for the interactive Swagger UI viewer) is an OpenAPI 3 spec **generated from the route tree** — please don't edit the spec by hand.

- Path, method, tags and security are derived automatically from `src/routes/api/**/+server.ts`. Static analysis also picks up query params, path params, status codes and request-body fields directly from each handler's code.
- The generator can't infer everything, though — a human-readable `summary`, param descriptions, request/response shapes and examples come from a `@openapi` JSDoc block written directly above the exported handler (`export const GET`/`POST`/etc). Use an existing well-annotated handler as a style reference, e.g. `src/routes/api/auth/tokens/+server.ts`.
- **When you add or change an endpoint:** add or update its `@openapi` block, then regenerate the spec with:
  ```bash
  npm run generate:openapi
  ```
- Before opening a PR, run the drift check:
  ```bash
  npm run generate:openapi:check
  ```
  This is the same check CI runs (`.github/workflows/openapi.yml`) and fails the build on drift — an undocumented endpoint, a stale query/path param, a wrong status code, or an orphaned annotation. It's how the docs stay in sync instead of quietly falling behind the code.

### OpenAPI annotations

The `@openapi` JSDoc mini-DSL used above has its own grammar reference, mandatory rules and a
binding cross-reference convention for IDs that come from another endpoint (e.g. an
`environmentId` you get from `GET /api/environments`) — see
[`docs/openapi-annotations.md`](docs/openapi-annotations.md). Read it before writing or changing
an `@openapi` block.

## CLA Agreement

When contributing to Dockhand, you will be asked to sign a Contributor License Agreement (CLA) to ensure that all contributions are properly licensed. This helps protect both you and the project. The agreement can be found [here](https://cla-assistant.io/Finsys/dockhand).