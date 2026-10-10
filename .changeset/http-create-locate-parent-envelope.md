---
"@sponson/adapters": minor
"@sponson/sim": minor
---

The generic `http` adapter takes three more shapes of API (ADR 0020, amendment 1). In `http.resource`, `create.locate: true` is for a create that answers with something other than the object, such as the parent it was added to: Sponson then finds the new object with `find` or `read`. In `http.list_item`, `parent.item_path` reads a parent that comes in an envelope (`{ feature: {...} }`) but is written bare. Also in `http.list_item`, `parent.send` now takes a list of the parent's fields, which are sent back with the collection. That suits a `PUT` that resets whatever it is not sent. Record ids of existing lines are unchanged. Recipes may now leave `base_url` out for a per-account API, giving a `base_url_example` instead. In the sim, the generic REST provider accepts a bare token in `Authorization`, adds creates posted to an alias path (`aliases`) to their collection, and answers an object in the `item_path` envelope of its style.
