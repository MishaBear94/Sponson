---
"@sponson/adapters": minor
---

Added recipes for deploy targets: `railway.variable` (a variable in a PR environment, GraphQL), `fly_machines.app` and
`fly.secret` (a per-PR Fly app and its secrets, compared by presence only), `amplify.branch` and
`amplify.branch_variable` (SigV4), `cloud_run.traffic_tag` (a per-PR revision tag, written with the service's etag) and
`azure_swa.build_app_setting` (an app setting of a preview environment).
