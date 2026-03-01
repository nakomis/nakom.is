# blog-app

React/Vite blog for blog.nakom.is. Deployed to S3 via CDK's BucketDeployment with CloudFront in front.

## Development

```bash
npm install
npm run dev
```

## Building

```bash
npm run build
```

This runs two steps:
1. `npm run content` — processes markdown files in `content/` into a generated JSON bundle (via `scripts/buildContent.ts`)
2. TypeScript compile + Vite build → `dist/`

## Deploying

### Content/asset-only changes (fast — no Lambda bundling)

Use this for changes to content, images, favicons, CSS, or the React app:

```bash
# Build
cd blog-app && npm run build

# Sync to S3
aws s3 sync dist/ s3://blog-nakom-is-eu-west-2-637423226886/ --delete --profile nakom.is-admin

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id E1YIX46VV6J06Y \
  --paths "/*" \
  --profile nakom.is-admin
```

### Infrastructure changes (CDK)

Use this when changing `lib/blog-stack.ts` (CloudFront config, S3 settings, DNS, etc.):

```bash
cd ..  # from blog-app/, go to repo root
AWS_PROFILE=nakom.is-admin cdk deploy BlogStack --require-approval never
```

Note: this synths the entire CDK app (including Docker-bundling all Lambdas) even if only BlogStack changed, so it's significantly slower than the direct S3 sync above.

## Generating the logo SVG from the PNG source

The `public/logo.svg` was generated from `public/logo-flat.png` using ImageMagick and potrace.
The black background must be removed first, otherwise potrace traces the background instead of the logo:

```bash
# 1. Replace black background with white, threshold so green areas (~44% luminosity) become black
magick logo-flat.png \
  -fuzz 20% -fill white -opaque black \
  -colorspace gray \
  -threshold 55% \
  /tmp/logo-flat-mask.pbm

# 2. Trace to SVG with the correct green fill and transparent background
potrace /tmp/logo-flat-mask.pbm -s -o public/logo.svg --color '#38983F'
```

## Making favicon backgrounds transparent

```bash
cd public/

# Remove black backgrounds (15% fuzz handles anti-aliased edges)
magick favicon-16.png -fuzz 15% -transparent black favicon-16.png
magick favicon-32.png -fuzz 15% -transparent black favicon-32.png

# Rebuild the .ico from both sizes
magick favicon-16.png favicon-32.png favicon.ico
```
