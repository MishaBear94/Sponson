---
"@sponson/adapters": minor
"@sponson/sim": minor
"@sponson/core": minor
---

The generic `http` adapter authenticates with an OAuth2 client-credentials token (`auth: { oauth2_client_credentials }`: Auth0, Kinde, Okta custom servers), a token a CLI prints (`auth: { command: [gcloud, auth, print-access-token] }`), AWS SigV4 (`auth: { aws_sigv4 }`) and HTTP Digest (`auth: { digest }`: MongoDB Atlas), speaks XML (`encoding: xml`, S3 bucket CORS) and GraphQL (`{ graphql: { query, variables, data_path } }` in place of any request of `http.resource`: Railway variables, Fly.io secrets). Tokens obtained at run time are registered with the redactor through the new optional `AdapterContext.secret`. `http.list_item` gains `parent.if_missing`, `parent.when_empty`, `parent.body_list_path`, `send: collection`, and API blocks a versioned `media_type`. The sim checks each scheme for real (an OAuth2 token endpoint, Digest challenges, SigV4 verification) and adds `aws`, `railway` and `fly` providers.
