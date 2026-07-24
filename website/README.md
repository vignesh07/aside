# Aside website

The public landing page and Mac download surface for Aside.

Aside gives every discovered Codex, Claude Code, and Pi session a persistent,
read-only side chat. The site explains that boundary, demonstrates the
needs-you workflow, and links to the signed installers published through the
Aside release service.

## Local development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

The local site runs at `http://localhost:3000`.

## Validation

```bash
npm test
npm run lint
```

`npm test` creates the production Worker build and checks the rendered page,
metadata, and stable download routes.
