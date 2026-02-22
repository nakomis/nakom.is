# SSE Streaming Architecture: CloudFront → Lambda Function URL

## Overview

The AI chat on nakom.is streams tool-call events (SSE) from a Lambda Function URL through CloudFront, enabling animated "data blobs" on SVG connector lines when the LangChain agent calls tools like `get_cv`, `get_linkedin_profile`, or `get_github_readme`.

## Architecture

```
Browser
  │  POST /chat-stream
  │  Headers: Content-Type, x-amz-content-sha256
  ▼
CloudFront (OAC: SigV4 signing)
  │  Signs request with lambda service SigV4
  ▼
Lambda Function URL (authType: AWS_IAM, invokeMode: RESPONSE_STREAM)
  │  awslambda.streamifyResponse() handler
  │  LangChain AgentExecutor with SSECallbackHandler
  ▼
SSE events streamed back:
  event: tool_start  {"tool":"get_cv"}
  event: tool_end    {"tool":"get_cv"}
  event: message     {"message":"...","remaining":95}
  event: done        {}
```

## Key Findings & Gotchas

### 1. Lambda "Block Public Access" (the 403 mystery)

AWS introduced "Block public access for Lambda Function URLs" (similar to S3 Block Public Access). When enabled (the default on newer account configurations), Lambda Function URLs with `authType: NONE` return 403 for ALL requests — even signed ones — **unless** the resource policy includes BOTH:

- `lambda:InvokeFunctionUrl` (the obvious one)
- `lambda:InvokeFunction` (the non-obvious one)

This was the root cause of 403 errors with `authType: NONE`. The error message is deliberately vague (`"Forbidden"`) and does not mention the public access block, making it very difficult to diagnose.

**Fix:** Don't use `authType: NONE`. Use `authType: AWS_IAM` with CloudFront OAC instead (see below).

**References:**
- [SST issue #6397](https://github.com/anomalyco/sst/issues/6397) — fixed in SST 3.18.1
- [Terraform issue #39396](https://github.com/hashicorp/terraform-provider-aws/issues/39396)

### 2. CloudFront OAC for Lambda Function URLs

CloudFront Origin Access Control (OAC) signs requests to Lambda using SigV4. This keeps the Lambda URL private (only CloudFront can invoke it).

**Critical requirement:** The Lambda resource policy needs BOTH actions:

```json
{
  "Effect": "Allow",
  "Principal": { "Service": "cloudfront.amazonaws.com" },
  "Action": "lambda:InvokeFunctionUrl",
  "Resource": "arn:aws:lambda:..."
}
```

AND:

```json
{
  "Effect": "Allow",
  "Principal": { "Service": "cloudfront.amazonaws.com" },
  "Action": "lambda:InvokeFunction",
  "Resource": "arn:aws:lambda:..."
}
```

Without `lambda:InvokeFunction`, OAC requests return 403 even though the SigV4 signature is correct.

### 3. OAC DOES work with RESPONSE_STREAM

Contrary to some 2024-era AWS documentation that stated "Origin access control doesn't support function URLs configured with the RESPONSE_STREAM InvokeMode" — this works fine as of February 2026. The earlier documentation appears to have been inaccurate or the limitation was subsequently removed.

Tested and confirmed: `authType: AWS_IAM` + CloudFront OAC + `invokeMode: RESPONSE_STREAM` + POST requests with SSE streaming response.

### 4. POST requests require `x-amz-content-sha256`

For POST/PUT requests through CloudFront OAC to Lambda, the **client must include** the SHA-256 hash of the request body in the `x-amz-content-sha256` header. This is because Lambda Function URLs don't support unsigned payloads with SigV4.

CloudFront Functions cannot compute this (they don't have access to the request body). Lambda@Edge could, but it's simpler to compute it client-side using the Web Crypto API. Note: `x-amz-content-sha256` cannot be configured in CloudFront origin request policies (it's a restricted header), but CloudFront automatically passes it through to OAC when the viewer sends it.

```typescript
async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Usage in fetch:
const body = JSON.stringify({ messages });
const hash = await sha256Hex(body);
const response = await fetch('/chat-stream', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-amz-content-sha256': hash,
  },
  body,
});
```

**References:**
- [AWS docs: Restrict access to Lambda function URL origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)
- [Elias Brange: Lambdalith with Lambda Function URLs and CloudFront](https://www.eliasbrange.dev/posts/lambdalith-auth-cloudfront-lambda-function-url/)

### 5. CDK doesn't natively support OAC for Lambda origins (yet)

CDK's L2 `Distribution` construct doesn't support OAC for Lambda Function URL origins. Use escape hatches:

```typescript
// Create OAC
const cfnOac = new cloudfront.CfnOriginAccessControl(this, 'StreamOAC', {
  originAccessControlConfig: {
    name: 'nakomis-stream-oac',
    originAccessControlOriginType: 'lambda',
    signingBehavior: 'always',
    signingProtocol: 'sigv4',
  },
});

// Attach OAC to the correct origin via escape hatch
const cfnDistrib = distribution.node.defaultChild as cloudfront.CfnDistribution;
cfnDistrib.addPropertyOverride(
  'DistributionConfig.Origins.1.OriginAccessControlId',
  cfnOac.attrId,
);
```

**Caution:** The origin index (`.1.`) depends on the order origins appear in the CloudFormation template. Verify with `cdk synth` or check the deployed distribution config.

**Reference:** [CDK issue #31629](https://github.com/aws/aws-cdk/issues/31629)

### 6. Cross-stack URL domain passing via SSM

Passing the Lambda Function URL domain from ChatStack to CloudfrontStack via CloudFormation exports creates tight coupling that blocks independent stack updates. Instead, use SSM:

```typescript
// ChatStack: write the domain
new ssm.StringParameter(this, 'StreamUrlDomainParam', {
  parameterName: '/nakom.is/stream-url-domain',
  stringValue: cdk.Fn.select(2, cdk.Fn.split('/', functionUrl.url)),
});

// CloudfrontStack: read at synth time (makes a real SSM API call)
const fnUrlDomain = ssm.StringParameter.valueFromLookup(
  this, '/nakom.is/stream-url-domain'
);
```

`valueFromLookup` embeds the concrete string at CDK synth time — no CloudFormation cross-stack reference.

### 7. Origin Request Policy

Use `CORS_CUSTOM_ORIGIN` for the streaming behavior. This forwards the `Origin` header but does NOT forward `Authorization` (which would conflict with OAC's SigV4 signing).

### 8. CORS is not needed (same-origin)

Since both the page (`https://nakom.is/`) and the streaming API (`https://nakom.is/chat-stream`) share the same origin, the browser treats all requests as same-origin. No CORS preflight is sent, and no CORS headers are needed in the Lambda response. Custom headers like `x-amz-content-sha256` are freely sent on same-origin requests without triggering preflight.

## Deploy Sequence

```bash
# 1. Deploy streaming Lambda + Function URL + SSM parameter
AWS_PROFILE=nakom.is-admin cdk deploy ChatStack

# 2. Deploy CloudFront with /chat-stream behavior + OAC
AWS_PROFILE=nakom.is-admin cdk deploy CloudfrontStack

# 3. Build and deploy frontend
cd social-app && npm run build && bash scripts/deploy.sh
```

## Testing

```bash
# Test SSE streaming with tool events
BODY='{"messages":[{"role":"user","content":"Tell me about your CV"}]}'
HASH=$(echo -n "$BODY" | openssl dgst -sha256 -hex | awk '{print $NF}')
curl -N -X POST "https://nakom.is/chat-stream" \
  -H "Content-Type: application/json" \
  -H "x-amz-content-sha256: $HASH" \
  -d "$BODY"
```

Expected output:
```
event: tool_start
data: {"tool":"get_cv"}

event: tool_end
data: {"tool":"get_cv"}

event: message
data: {"message":"...","remaining":82}

event: done
data: {}
```
