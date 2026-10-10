---
"@sponson/adapters": minor
---

Added the `aws-sm://` secret source: `{ secret: "aws-sm://<secret-id>" }` reads an AWS Secrets Manager secret through the `aws` CLI (name or ARN; region and credentials from the CLI's usual environment), and `aws-sm://<secret-id>#KEY` picks one key of a JSON key/value secret.
