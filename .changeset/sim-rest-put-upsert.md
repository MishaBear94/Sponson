---
"@sponson/sim": minor
---

The generic REST sim creates an object on a PUT to `<collection>/<id>` that does not exist yet (an upsert at a client-chosen key, as Render's environment variables are written), and an alias of a collection also addresses its objects (`/databases/<id>` when `/databases` aliases `/projects/p/databases`), so recipes for such APIs are tested end to end.
