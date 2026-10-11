---
"@sponson/adapters": minor
---

**Breaking:** the `cloud_run.traffic_tag` recipe is removed; `cloud_run.revision` makes the revision and its tag (ADR 0023). Before upgrading, run `sponson apply --destroy` for every open scope with a `recipe: cloud_run.traffic_tag` line (or remove those tags with `gcloud run services update-traffic <service> --remove-tags <tag>`), then replace the line with `adapter: cloud_run`, `op: revision` and the image and variables your deploy used to set.
