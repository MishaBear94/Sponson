---
"@sponson/sim": minor
---

The generic REST sim creates an object on a PUT to `<collection>/<id>` that does not exist yet (an upsert at a client-chosen key, as Render's environment variables are written), so recipes that create that way are tested end to end.
