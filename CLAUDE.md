# nakom.is — Project Notes for Claude

## AWS / CDK

### Always use `cdk` directly, never `npx cdk`
`cdk` is installed globally. Running via `npx cdk` spawns a child process that loses the AWS SSO authentication context, causing credential errors. Always use:

```bash
cdk deploy ...
cdk synth ...
cdk diff ...
```

### Deploy credentials
AWS SSO profile: `nakom.is-admin`

```bash
AWS_PROFILE=nakom.is-admin cdk deploy StackName
```

### Deploy order (when deploying everything from scratch)
```
Route53Stack → CertificateStack → SESStack → ChatStack → S3Stack → LambdaStack → ApiGatewayStack → CloudfrontStack → Route53AdditionalStack
```
For chat-only changes: `SESStack → ChatStack`, then `social-app/scripts/deploy.sh` for the React app.

## Architecture overview
See plan file for full architecture. Key points:
- CloudFront → API Gateway → Lambda (eu-west-2)
- Three domains: nakom.is, nakomis.com, nakomis.co.uk (all same distribution)
- Certificate is in us-east-1 (CloudFront requirement), everything else eu-west-2
- Chat Lambda uses `binaryMediaTypes: ["*/*"]` on API Gateway → bodies arrive base64-encoded; handler decodes via `event.isBase64Encoded`
- API key injected by CloudFront as `x-api-key` header (never in client code)

## Secrets

No `secrets.json` is needed — `cdk synth` and `cdk deploy` run without any local secrets file.

Both `/nakom.is/anthropic-api-key` and `/nakom.is/martin-email` are created by CDK with a `PLACEHOLDER` value on first deploy. Update them via the console or CLI afterwards:

```bash
AWS_PROFILE=nakom.is-admin aws ssm put-parameter \
  --name /nakom.is/anthropic-api-key \
  --value "sk-ant-..." \
  --type String --overwrite \
  --region eu-west-2

AWS_PROFILE=nakom.is-admin aws ssm put-parameter \
  --name /nakom.is/martin-email \
  --value "martin@nakomis.com" \
  --type String --overwrite \
  --region eu-west-2
```

## URL shortener resolvers

`lambda/shortener/handler.ts` runs the path through an ordered chain of resolvers (`lambda/shortener/resolvers/`); the first match wins and Google is always last.

- `match()` must be pure and synchronous. Only the winning resolver does I/O; `resolve()` may return `null` to decline and let the chain continue.
- Resolvers that own a namespace match a `word/` prefix (e.g. `plane/`, `imdb/`). Short links in the `redirects` table must never contain a `/`, so the two can't collide.
- `plane/<alias> <ref>` (and the legacy `taiga/` prefix) uses the `ticket-projects` table (`alias` → `urlTemplate` with `{ref}`, plus `projectUrl` for `plane/<alias>` with no ref). The rows are data: edit them directly rather than redeploying. A new Plane project's row is written by the Plane MCP when it creates the project, and its `sync_shortener_projects` tool upserts every project (archived included) to backfill or recover. `scripts/seed-ticket-projects.sh` only writes the hand-picked extra aliases (`nako`, `nest`, `lapcat`, …), which Plane knows nothing about. The Lambda never calls Plane: the URLs are static, so no API key or client certificate lives in AWS.

## Blog RAG search

The chat assistant and blog search UI use semantic search over blog posts.

- **`blog-embeddings.json`** in `nakom.is-private` S3 — compact file loaded at cold start. Contains chunk IDs, base64-encoded Float32 embeddings, post slugs, and tags. Regenerate by running `ingest-blog.py` in the `blog-app` repo.
- **`blog-chunks` DynamoDB table** — chunk text and metadata (title, URL, heading, excerpt), keyed on chunk ID (e.g. `my-post:3`). Written by the same ingest script.
- **`lambda/chat/blog-retriever.ts`** — loads the S3 file at cold start, runs in-memory cosine similarity, then fetches text from DynamoDB via `BatchGetItem`. Used by all three Lambdas: `nakomis-chat`, `nakomis-chat-stream`, `nakomis-blog-search`.

Required env vars on all three Lambdas: `PRIVATE_BUCKET`, `BLOG_CHUNKS_TABLE`.

## React SPA
- Built with Vite, served from S3 via `/static/social-app/` path
- Deploy: `cd social-app && npm run build && bash scripts/deploy.sh`
- Base URL is `/static/social-app/` — don't change this without updating API Gateway and deploy script
