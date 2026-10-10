---
"@sponson/sim": minor
---

The generic REST sim creates an object on a PUT to `<collection>/<id>` that does not exist yet (an upsert at a client-chosen key, as Render's environment variables are written), and a collection's style may list other paths it is listed and addressed at (`also_at`: created at `/projects/p/databases`, read at `/databases/<id>`), so recipes for such APIs are tested end to end.
