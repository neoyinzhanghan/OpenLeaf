# Contributing to OpenLeaf

Thanks for wanting to help. OpenLeaf is MIT-licensed; by opening a pull request you agree your contribution is licensed under the same [MIT License](LICENSE) (copyright: OpenLeaf contributors).

## Development

```bash
npm install
npm run dev          # Vite :5173 + API :8787
node cli/bin/openleaf.js setup   # ordinary-user setup; works before the app is built
npm run typecheck
npm test             # server tests and CLI tests
```

Use the Vite URL in development (`http://127.0.0.1:5173`), not `:8787`.

See [README.md](README.md) for install prerequisites and [AGENTS.md](AGENTS.md) for layout conventions.

## Pull requests

- Keep changes focused; match existing TypeScript / React style.
- Prefer editing `server/src/services/` for behavior and thin `routes/` for HTTP.
- Add or update tests under `server/src/services/*.test.ts` when you change logic.
- Do not commit secrets, local projects, or build artifacts (see [SECURITY.md](SECURITY.md)).

## Reporting issues

Use GitHub Issues for bugs and feature ideas. For security-sensitive reports, follow [SECURITY.md](SECURITY.md).
