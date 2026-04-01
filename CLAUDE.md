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
`secrets.json` (gitignored) holds the Anthropic API key and Martin's contact email. Copy from `secrets.json.template` to get started.

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
