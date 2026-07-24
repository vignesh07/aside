# Aside website

The public landing page and Mac download surface for Aside.

Production: [aside.vgnsh.xyz](https://aside.vgnsh.xyz)

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

## Download analytics

The Railway deployment records one anonymous event when a browser starts a DMG
download through `/download/mac-arm64` or `/download/mac-intel`. It does not
store IP addresses, user agents, or referrers, and HEAD checks are not counted.

The events live in `aside-analytics.sqlite` on the volume mounted to
`aside-web`. The private dashboard is available at `/admin` after setting:

```bash
ASIDE_ADMIN_KEY="$(openssl rand -base64 32)"
```

The key is exchanged for a 12-hour, HTTP-only admin session cookie. The
dashboard reports rolling 7-day, rolling 30-day, and all-time counts; tracking
begins when the analytics-enabled website deployment goes live.
