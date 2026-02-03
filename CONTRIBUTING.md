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

## CLA Agreement

When contributing to Dockhand, you will be asked to sign a Contributor License Agreement (CLA) to ensure that all contributions are properly licensed. This helps protect both you and the project. The agreement can be found [here](https://cla-assistant.io/Finsys/dockhand).