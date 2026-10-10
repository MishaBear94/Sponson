---
"sponson": minor
---

`sponson init` now detects the stack from the repository's files (Vercel, Neon, Clerk, Next.js, Remix, SvelteKit,
Astro, Nuxt, Prisma, Drizzle) and writes a plan with a line only for what it found, the project ids it can find
(`.vercel/project.json`, `.neon`) and a `TODO` saying where to look for the others. Services Sponson does not manage
yet (Supabase, PlanetScale, Auth0, Netlify, Cloudflare, LaunchDarkly, PostHog, Stripe, Sentry, …) are reported as
not supported. It reads variable names from `.env*` files, never their values. `init --json` has a new `detected`
field (`null` when the plan already existed).
