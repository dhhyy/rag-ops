# rag-ops web

A local desktop UI prototype inspired by the supplied smart-home motion reference.
English interface, React + TypeScript + Motion, served by a Rust / Axum process.

## Scope

Home, Knowledge base, RAG pipeline, Playground, Evaluations, Run history,
Conversations, and Settings. Sample data only: no RAG inference, document ingestion,
real evaluation, authentication, or cloud connections. Preview changes and
conversations live in memory and reset on reload. All fonts are bundled locally.

## Run on macOS

From the macOS Terminal:

```sh
cd web  # 저장소 루트에서
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4173. Requires Node.js 22+ and Rust 1.94+.
If your global npm cache has ownership problems, use `npm ci --cache /tmp/rag-ops-npm-cache`.
Stop the server with Ctrl+C.

For UI development with hot reload:

```sh
npm run dev
```

Open http://127.0.0.1:5173. This Vite development server does not require Rust.

## Docker Desktop on macOS

Start Docker Desktop, then run from the project directory in macOS Terminal:

```sh
docker compose up --build -d
```

Open http://127.0.0.1:4173. Stop any native server using 4173 first.
The multi-stage image builds the frontend and Rust binary; the final container
runs as a non-root user and exposes the service only on host loopback.

```sh
docker compose down
```

## Checks

```sh
npm run build
cargo check --locked --manifest-path server/Cargo.toml
curl http://127.0.0.1:4173/api/health
```

See `DESIGN.md` for visual decisions and `docs/QA.md` for observed UI checks.
The reference video remains in its original location; it is not bundled or uploaded.
Motion follows the user's OS reduced-motion preference.

## Structure

- `src/main.tsx` — prototype screens, preview state, interactions
- `src/styles.css` — reference-based design tokens, layout and CSS motion
- `server/src/main.rs` — Rust static server and health endpoint
- `Dockerfile`, `compose.yaml` — local Docker distribution
- `public/fonts` — bundled DM Sans fonts and SIL license

Implementation references: [Motion AnimatePresence](https://motion.dev/docs/react-animate-presence),
[Motion accessibility](https://motion.dev/docs/react-accessibility),
[Axum serve](https://docs.rs/axum/latest/axum/serve/index.html).
