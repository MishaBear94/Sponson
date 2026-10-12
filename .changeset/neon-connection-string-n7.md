---
"@sponson/adapters": patch
"@sponson/sim": patch
---

Neon: a branch's `connection_string` output now always comes from GET /connection_uri. Neon's create answer gives the same string without `channel_binding=require`, so a plan that put it into a Vercel or Netlify variable rewrote that variable (and triggered a redeploy) on the second apply. Found by the first live run against real accounts.
