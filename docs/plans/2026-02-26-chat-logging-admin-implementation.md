# Chat Logging & Admin Analytics — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Log every nakom.is chat request to DynamoDB, then build a new `nakom-admin` project at `admin.nakom.is` with an analytics dashboard — on-demand RDS/pgvector, semantic similarity graphs, topic clustering, tool-usage stats, spam detection, and cheap CloudFront-Function-based IP blocking.

**Architecture:** Two workstreams. (1) nakom.is: add `nakomis-chat-logs` DDB table to `ChatStack`, wire async logging into both chat Lambda handlers, add a monitoring Lambda that alerts via SES+SNS. (2) New `nakom-admin` repo in the same AWS account (637423226886, eu-west-2): Cognito, CloudFront, API Gateway, on-demand RDS t4g.micro with pgvector, and a React admin app copied from the sandbox styling. Import Lambdas use a VPC-split pattern: embedding generation outside the VPC (calls Bedrock), bulk RDS insertion inside the VPC (private subnets, S3 Gateway endpoint, no NAT Gateway).

**Tech Stack:** AWS CDK v2 (TypeScript), Node.js 20, Lambda (NodejsFunction/esbuild), DynamoDB PAY_PER_REQUEST, PostgreSQL 16 + pgvector, Amazon Bedrock Titan Embed v2, React 19 + Vite, MUI v6, D3.js v7, Jest + ts-jest.

---

## Phase 1: nakom.is — DDB Logging Table

### Task 1: Add `nakomis-chat-logs` table to ChatStack

**Files:**
- Modify: `lib/chat-stack.ts`
- Modify: `bin/nakom.is.ts` (export the table for monitoring stack later)

**Step 1: Add the table and SSM cursor parameter**

In `lib/chat-stack.ts`, after the `rateLimitTable` declaration, add:

```typescript
// Chat request logging table
const chatLogsTable = new dynamodb.TableV2(this, 'ChatLogs', {
    tableName: 'nakomis-chat-logs',
    partitionKey: { name: 'logType', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    timeToLiveAttribute: 'ttl',
    billing: dynamodb.Billing.onDemand(),
});

// SSM cursor — last timestamp successfully imported to RDS
// Value: ISO-8601 string, e.g. "2026-01-01T00:00:00.000Z"
// One per logType, so path is /nakom.is/analytics/{logType}/last-imported-timestamp
new ssm.StringParameter(this, 'CvChatImportCursor', {
    parameterName: '/nakom.is/analytics/CVCHAT/last-imported-timestamp',
    description: 'Timestamp of last DDB record imported to RDS analytics DB',
    stringValue: '1970-01-01T00:00:00.000Z',
});
```

Export the table as a public readonly on the class so `bin/nakom.is.ts` can pass it to the monitoring stack later:

```typescript
readonly chatLogsTable: dynamodb.TableV2;
```

**Step 2: Grant write access to both Lambda functions**

After creating the table, grant `PutItem` to both Lambdas:

```typescript
chatLogsTable.grant(this.chatFunction, 'dynamodb:PutItem');
chatLogsTable.grant(this.streamChatFunction, 'dynamodb:PutItem');
```

Also pass the table name as an env var to both functions — add `CHAT_LOGS_TABLE: chatLogsTable.tableName` to each `environment` block.

**Step 3: Deploy and verify**

```bash
AWS_PROFILE=nakom.is-admin cdk diff ChatStack
AWS_PROFILE=nakom.is-admin cdk deploy ChatStack
```

Expected: one new DDB table, one new SSM parameter, two IAM policy additions. No Lambda code changes yet.

**Step 4: Commit**

```bash
git add lib/chat-stack.ts
git commit -m "feat(logging): add nakomis-chat-logs DDB table and SSM import cursor"
```

---

### Task 2: Add `conversationId` to the chat frontend

**Files:**
- Modify: `social-app/src/components/ChatWidget.tsx`

The `conversationId` is a UUID v4 generated once when the widget mounts and sent with every request in the same session. Not a security nonce — it's a correlation ID for analytics.

**Step 1: Generate and store the conversationId**

Add a `useRef` so the ID persists across re-renders without causing re-renders itself:

```typescript
import { useState, useRef, useEffect, useCallback } from 'react';

// Near the top of the ChatWidget function, with the other refs:
const conversationId = useRef<string>(crypto.randomUUID());
```

**Step 2: Include it in every request body**

Find the `sendMessage` function's `body` construction (line 66):

```typescript
// Before (line 66):
const body = JSON.stringify({ messages: updatedMessages });

// After:
const body = JSON.stringify({ messages: updatedMessages, conversationId: conversationId.current });
```

The `sha256Hex` call and hash header already operate on `body`, so the hash automatically covers the new field. No further changes needed.

**Step 3: Build and smoke-test locally**

```bash
cd social-app && npm run build
```

Open the app, send a chat message, verify the request payload in DevTools Network tab includes `conversationId`.

**Step 4: Commit**

```bash
git add social-app/src/components/ChatWidget.tsx
git commit -m "feat(logging): send conversationId with every chat-stream request"
```

---

### Task 3: Add the log-entry builder and async logger to stream-handler

**Files:**
- Create: `lambda/chat/chat-logger.ts`
- Modify: `lambda/chat/stream-handler.ts`

**Step 1: Write the failing test**

Create `lambda/chat/chat-logger.test.ts`:

```typescript
import { buildLogEntry } from './chat-logger';

describe('buildLogEntry', () => {
  const baseEvent = {
    headers: {
      'x-forwarded-for': '203.0.113.42, 10.0.0.1',
      'user-agent': 'Mozilla/5.0',
      'cloudfront-viewer-country': 'GB',
    },
    requestContext: {},
  };

  it('extracts the first IP from X-Forwarded-For', () => {
    const entry = buildLogEntry({
      event: baseEvent,
      conversationId: 'conv-123',
      userMessage: 'Hello',
      messageCount: 1,
      toolsCalled: ['get_cv'],
      inputTokens: 150,
      outputTokens: 300,
      durationMs: 1234,
      rateLimited: false,
    });

    expect(entry.ip).toBe('203.0.113.42');
    expect(entry.logType).toBe('CVCHAT');
    expect(entry.userMessage).toBe('Hello');
    expect(entry.toolsCalled).toEqual(new Set(['get_cv']));
    expect(entry.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('handles missing X-Forwarded-For gracefully', () => {
    const event = { headers: {}, requestContext: {} };
    const entry = buildLogEntry({ event, conversationId: 'c', userMessage: 'm',
      messageCount: 1, toolsCalled: [], inputTokens: 0, outputTokens: 0,
      durationMs: 0, rateLimited: false });
    expect(entry.ip).toBe('unknown');
  });

  it('sets ttl to approximately 1 year from now', () => {
    const entry = buildLogEntry({ event: baseEvent, conversationId: 'c',
      userMessage: 'm', messageCount: 1, toolsCalled: [], inputTokens: 0,
      outputTokens: 0, durationMs: 0, rateLimited: false });
    const oneYear = 365 * 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);
    expect(entry.ttl).toBeGreaterThanOrEqual(now + oneYear - 5);
    expect(entry.ttl).toBeLessThanOrEqual(now + oneYear + 5);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /path/to/nakom.is
npx jest lambda/chat/chat-logger.test.ts --testPathPattern=chat-logger
```

Expected: FAIL — `Cannot find module './chat-logger'`

**Step 3: Implement `chat-logger.ts`**

```typescript
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';

const dynamoClient = new DynamoDBClient({});

export interface LogEntryInput {
  event: any;
  conversationId: string;
  userMessage: string;
  messageCount: number;
  toolsCalled: string[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  rateLimited: boolean;
}

export interface LogEntry {
  logType: string;
  sk: string;
  conversationId: string;
  ip: string;
  userAgent: string;
  country: string;
  userMessage: string;
  messageCount: number;
  toolsCalled: Set<string>;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  rateLimited: boolean;
  ttl: number;
}

export function buildLogEntry(input: LogEntryInput): LogEntry {
  const headers = input.event?.headers ?? {};
  const forwarded: string = headers['x-forwarded-for'] ?? headers['X-Forwarded-For'] ?? '';
  const ip = forwarded.split(',')[0]?.trim() || 'unknown';
  const userAgent: string = headers['user-agent'] ?? headers['User-Agent'] ?? 'unknown';
  const country: string = headers['cloudfront-viewer-country'] ?? headers['CloudFront-Viewer-Country'] ?? 'unknown';

  const now = new Date();
  const timestamp = now.toISOString();
  const requestId = randomUUID();
  const ttl = Math.floor(now.getTime() / 1000) + 365 * 24 * 60 * 60;

  return {
    logType: 'CVCHAT',
    sk: `${timestamp}#${requestId}`,
    conversationId: input.conversationId,
    ip,
    userAgent,
    country,
    userMessage: input.userMessage,
    messageCount: input.messageCount,
    toolsCalled: new Set(input.toolsCalled),
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    durationMs: input.durationMs,
    rateLimited: input.rateLimited,
    ttl,
  };
}

export async function writeLogEntry(entry: LogEntry, tableName: string): Promise<void> {
  const item: Record<string, any> = {
    logType: { S: entry.logType },
    sk: { S: entry.sk },
    conversationId: { S: entry.conversationId },
    ip: { S: entry.ip },
    userAgent: { S: entry.userAgent },
    country: { S: entry.country },
    userMessage: { S: entry.userMessage.slice(0, 2000) }, // guard against oversized values
    messageCount: { N: String(entry.messageCount) },
    inputTokens: { N: String(entry.inputTokens) },
    outputTokens: { N: String(entry.outputTokens) },
    durationMs: { N: String(entry.durationMs) },
    rateLimited: { BOOL: entry.rateLimited },
    ttl: { N: String(entry.ttl) },
  };

  if (entry.toolsCalled.size > 0) {
    item.toolsCalled = { SS: [...entry.toolsCalled] };
  }

  await dynamoClient.send(new PutItemCommand({
    TableName: tableName,
    Item: item,
  }));
}
```

**Step 4: Run test to verify it passes**

```bash
npx jest lambda/chat/chat-logger.test.ts --testPathPattern=chat-logger
```

Expected: PASS (3 tests)

**Step 5: Wire into stream-handler.ts**

The handler accumulates tool names and token counts via callbacks. Update `SSECallbackHandler`:

```typescript
import { buildLogEntry, writeLogEntry } from './chat-logger';
import type { LLMResult } from '@langchain/core/outputs';

class SSECallbackHandler extends BaseCallbackHandler {
  // ... existing fields ...
  readonly toolsCalledInRun: string[] = [];
  inputTokens = 0;
  outputTokens = 0;

  // Add to existing handleToolStart — also push to toolsCalledInRun:
  async handleToolStart(tool, _input, runId, _parentRunId, _tags, _metadata, runName) {
    const toolName = runName || tool.id?.[tool.id.length - 1] || 'unknown';
    this.runIdToToolName.set(runId, toolName);
    this.toolsCalledInRun.push(toolName);   // NEW
    writeSSE(this.stream, 'tool_start', { tool: toolName });
  }

  // NEW — capture token usage
  async handleLLMEnd(output: LLMResult): Promise<void> {
    const usage = output.llmOutput?.tokenUsage;
    if (usage) {
      this.inputTokens += usage.promptTokens ?? 0;
      this.outputTokens += usage.completionTokens ?? 0;
    }
  }
}
```

After `executor.invoke()` returns and just before `writeSSE(responseStream, 'done', {})`, add the async log write (fire-and-forget, don't await, don't block the response):

```typescript
const logsTable = process.env.CHAT_LOGS_TABLE;
if (logsTable) {
  const entry = buildLogEntry({
    event,
    conversationId: body.conversationId ?? 'unknown',
    userMessage: lastMsg.content,
    messageCount: messages.length,
    toolsCalled: sseHandler.toolsCalledInRun,
    inputTokens: sseHandler.inputTokens,
    outputTokens: sseHandler.outputTokens,
    durationMs: Date.now() - requestStartMs,
    rateLimited: false,
  });
  writeLogEntry(entry, logsTable).catch(err =>
    console.error('Chat log write failed (non-fatal):', err)
  );
}
```

Add `const requestStartMs = Date.now();` at the top of the handler body.

**Step 6: Commit**

```bash
git add lambda/chat/chat-logger.ts lambda/chat/chat-logger.test.ts lambda/chat/stream-handler.ts
git commit -m "feat(logging): async chat request logging to DynamoDB in stream handler"
```

---

### Task 4: Add async logging to handler.ts

**Files:**
- Modify: `lambda/chat/handler.ts`

The regular (non-streaming) handler doesn't use callbacks. LangChain's `AgentExecutor.invoke()` returns the final result without token usage metadata in the same way. Log what we can: IP, UA, tools aren't easily extracted without a callback. Add a minimal callback to capture tools and tokens, same pattern as Task 3.

**Step 1: Import and add a lean callback handler**

At the top of `handler.ts`:

```typescript
import { buildLogEntry, writeLogEntry } from './chat-logger';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import type { Serialized } from '@langchain/core/load/serializable';

class LoggingCallbackHandler extends BaseCallbackHandler {
  name = 'LoggingCallbackHandler';
  awaitHandlers = false;
  readonly toolsCalled: string[] = [];
  inputTokens = 0;
  outputTokens = 0;

  async handleToolStart(_tool: Serialized, _input: string, _runId: string,
    _parentRunId?: string, _tags?: string[], _metadata?: Record<string, unknown>,
    runName?: string): Promise<void> {
    const toolName = runName || 'unknown';
    this.toolsCalled.push(toolName);
  }

  async handleLLMEnd(output: LLMResult): Promise<void> {
    const usage = output.llmOutput?.tokenUsage;
    if (usage) {
      this.inputTokens += usage.promptTokens ?? 0;
      this.outputTokens += usage.completionTokens ?? 0;
    }
  }
}
```

**Step 2: Wire into the normal chat path**

After `const model = await getModel();`, add:

```typescript
const loggingCallback = new LoggingCallbackHandler();
const requestStartMs = Date.now();
```

Change the `executor.invoke` call to pass the callback:

```typescript
const result = await executor.invoke(
  { input: lastMsg.content, chat_history: chatHistory },
  { callbacks: [loggingCallback] },
);
```

After the response is assembled and before `return`, fire-and-forget the log write:

```typescript
const logsTable = process.env.CHAT_LOGS_TABLE;
if (logsTable) {
  const logEntry = buildLogEntry({
    event,
    conversationId: body.conversationId ?? 'unknown',
    userMessage: lastMsg.content,
    messageCount: messages.length,
    toolsCalled: loggingCallback.toolsCalled,
    inputTokens: loggingCallback.inputTokens,
    outputTokens: loggingCallback.outputTokens,
    durationMs: Date.now() - requestStartMs,
    rateLimited: false,
  });
  writeLogEntry(logEntry, logsTable).catch(err =>
    console.error('Chat log write failed (non-fatal):', err)
  );
}
```

Note: also log the rate-limited path — before returning 429, fire a log entry with `rateLimited: true`.

**Step 3: Deploy both handlers**

```bash
AWS_PROFILE=nakom.is-admin cdk deploy ChatStack
```

**Step 4: Smoke test**

Send a chat message on the live site. Check DynamoDB:

```bash
AWS_PROFILE=nakom.is-admin aws dynamodb query \
  --table-name nakomis-chat-logs \
  --key-condition-expression "logType = :lt" \
  --expression-attribute-values '{":lt":{"S":"CVCHAT"}}' \
  --limit 3 \
  --region eu-west-2
```

Expected: at least one item with your IP, user agent, and the message you sent.

**Step 5: Commit**

```bash
git add lambda/chat/handler.ts
git commit -m "feat(logging): async chat request logging in regular handler"
```

---

### Task 5: Add monitoring Lambda and daily alert

**Files:**
- Create: `lambda/monitor/handler.ts`
- Modify: `lib/chat-stack.ts`

**Step 1: Write the monitoring Lambda**

Create `lambda/monitor/handler.ts`:

```typescript
import { DynamoDBClient, QueryCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const ddb = new DynamoDBClient({});
const ses = new SESClient({});
const sns = new SNSClient({});

// SMS deduplication: store a DDB item with logType=SMS_SENT and sk=today's date, TTL=24h.
// If it already exists, skip SMS.
async function smsSentToday(tableName: string): Promise<boolean> {
  const today = new Date().toISOString().split('T')[0];
  const result = await ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'logType = :lt AND sk = :sk',
    ExpressionAttributeValues: {
      ':lt': { S: 'SMS_SENT' },
      ':sk': { S: today },
    },
    Limit: 1,
  }));
  return (result.Count ?? 0) > 0;
}

async function markSmsSent(tableName: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const ttl = Math.floor(Date.now() / 1000) + 25 * 60 * 60; // 25h TTL
  await ddb.send(new PutItemCommand({
    TableName: tableName,
    Item: {
      logType: { S: 'SMS_SENT' },
      sk: { S: today },
      ttl: { N: String(ttl) },
    },
  }));
}

export const handler = async (): Promise<void> => {
  const tableName = process.env.CHAT_LOGS_TABLE!;
  const fromEmail = process.env.SES_FROM_EMAIL!;
  const toEmail = process.env.MARTIN_EMAIL!;
  const snsTopicArn = process.env.SNS_TOPIC_ARN!;
  const dailyThreshold = parseInt(process.env.DAILY_REQUEST_ALERT_THRESHOLD ?? '50', 10);

  // Count requests in the last 24h by querying today's timestamp prefix
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = await ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'logType = :lt AND sk > :since',
    ExpressionAttributeValues: {
      ':lt': { S: 'CVCHAT' },
      ':since': { S: since },
    },
    Select: 'COUNT',
  }));

  const count = result.Count ?? 0;

  if (count < dailyThreshold) return; // nothing to report

  const subject = `nakom.is chat alert: ${count} requests in last 24h`;
  const body = `Chat volume alert:\n\n${count} requests in the last 24 hours (threshold: ${dailyThreshold}).\n\nCheck admin.nakom.is for details.`;

  // Always send email
  await ses.send(new SendEmailCommand({
    Source: fromEmail,
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Text: { Data: body, Charset: 'UTF-8' } },
    },
  }));

  // Send SMS at most once per day
  const alreadySent = await smsSentToday(tableName);
  if (!alreadySent) {
    await sns.send(new PublishCommand({
      TopicArn: snsTopicArn,
      Message: `nakom.is: ${count} chat requests in 24h (threshold: ${dailyThreshold}). Check admin.nakom.is`,
    }));
    await markSmsSent(tableName);
  }
};
```

**Step 2: Add to ChatStack**

In `lib/chat-stack.ts`, add after the existing log groups:

```typescript
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

// SNS topic for SMS alert
const alertTopic = new sns.Topic(this, 'ChatAlertTopic', {
    topicName: 'nakomis-chat-alerts',
});
// Replace +447XXXXXXXXX with Martin's number — store the actual number in secrets.json
alertTopic.addSubscription(new subscriptions.SmsSubscription(
    secrets.martinMobile,  // add martinMobile to secrets.json + template
));

// Monitoring Lambda
const monitorLogGroup = new LogGroup(this, 'MonitorLambdaLogs', {
    logGroupName: '/nakom.is/lambda/monitor',
    retention: RetentionDays.THREE_MONTHS,
});

const monitorFn = new NodejsFunction(this, 'MonitorFunction', {
    functionName: 'nakomis-chat-monitor',
    entry: 'lambda/monitor/handler.ts',
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_20_X,
    memorySize: 128,
    timeout: Duration.seconds(30),
    logGroup: monitorLogGroup,
    environment: {
        CHAT_LOGS_TABLE: chatLogsTable.tableName,
        SES_FROM_EMAIL: props.sesFromAddress,
        MARTIN_EMAIL: secrets.martinEmail,
        SNS_TOPIC_ARN: alertTopic.topicArn,
        DAILY_REQUEST_ALERT_THRESHOLD: '50',
    },
    bundling: { minify: true, sourceMap: true },
});

chatLogsTable.grant(monitorFn, 'dynamodb:Query', 'dynamodb:PutItem');
alertTopic.grantPublish(monitorFn);
monitorFn.addToRolePolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['ses:SendEmail'],
    resources: [
        props.sesIdentity.emailIdentityArn,
        `arn:${this.partition}:ses:${this.region}:${this.account}:identity/*@nakom.is`,
    ],
}));

// EventBridge daily trigger at 08:00 UTC
new events.Rule(this, 'MonitorDailyRule', {
    schedule: events.Schedule.cron({ minute: '0', hour: '8' }),
    targets: [new targets.LambdaFunction(monitorFn)],
});
```

Add `martinMobile` to `secrets.json` and `secrets.json.template`.

**Step 3: Deploy**

```bash
AWS_PROFILE=nakom.is-admin cdk deploy ChatStack
```

**Step 4: Smoke test the Lambda manually**

```bash
AWS_PROFILE=nakom.is-admin aws lambda invoke \
  --function-name nakomis-chat-monitor \
  --region eu-west-2 \
  /tmp/monitor-out.json && cat /tmp/monitor-out.json
```

**Step 5: Commit**

```bash
git add lambda/monitor/handler.ts lib/chat-stack.ts secrets.json.template
git commit -m "feat(monitoring): daily alert Lambda with SES email and SNS SMS (capped 1/day)"
```

---

### Task 6: Enable CloudFront access logging

**Files:**
- Modify: `lib/cloudfront-stack.ts`

CloudFront access logs are required for the "bad actor" log mining feature in the admin app.

**Step 1: Add logging bucket and enable access logs**

```typescript
// Logging bucket — in CloudfrontStack, after the distribution is created:
import * as s3 from 'aws-cdk-lib/aws-s3';

const loggingBucket = new s3.Bucket(this, 'AccessLogsBucket', {
    bucketName: 'nakomis-cf-access-logs',
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // required for CF log delivery
    lifecycleRules: [{
        // Keep logs for 90 days — enough for the admin app to mine recent traffic
        expiration: cdk.Duration.days(90),
    }],
    removalPolicy: cdk.RemovalPolicy.RETAIN,
});
```

Add `enableLogging` and `logBucket` to the Distribution construct call:

```typescript
this.distrubution = new cloudfront.Distribution(this, 'NakomIsDistribution', {
    // ... existing props ...
    enableLogging: true,
    logBucket: loggingBucket,
    logFilePrefix: 'cf-logs/',
});
```

Export the bucket name as an SSM parameter so the admin app's Lambda can find it:

```typescript
new ssm.StringParameter(this, 'AccessLogsBucketParam', {
    parameterName: '/nakom.is/cf-access-logs-bucket',
    stringValue: loggingBucket.bucketName,
});
```

**Step 2: Deploy**

```bash
AWS_PROFILE=nakom.is-admin cdk deploy CloudfrontStack
```

**Step 3: Verify logs appear**

After a few minutes and some traffic, check:

```bash
AWS_PROFILE=nakom.is-admin aws s3 ls s3://nakomis-cf-access-logs/cf-logs/ --region eu-west-2
```

Expected: `.gz` log files appearing.

**Step 4: Commit**

```bash
git add lib/cloudfront-stack.ts
git commit -m "feat(logging): enable CloudFront access logging to S3 for bad-actor mining"
```

---

## Phase 2: nakom-admin — Repo Scaffold

### Task 7: Create the `nakom-admin` repo

**This task is done outside the nakom.is repo.**

**Step 1: Create the repo on GitHub**

```bash
gh repo create nakom-admin --public --license CC0-1.0 --description "Admin dashboard for nakom.is — analytics, chat logs, spam blocking"
```

**Step 2: Clone and create directory structure**

```bash
git clone git@github.com:nakomis/nakom-admin.git
cd nakom-admin
mkdir -p infra/bin infra/lib infra/lambda/rds-control infra/lambda/import-generate \
          infra/lambda/import-execute infra/lambda/query infra/lambda/monitor-logs \
          infra/lambda/blocklist \
          web/src/components/pages web/src/services web/src/config web/scripts \
          docs/diagrams .githooks
```

**Step 3: Create the `.githooks/pre-commit` script**

```bash
cat > .githooks/pre-commit << 'EOF'
#!/bin/sh
# Export modified .drawio files to SVG before commit.
# Requires draw.io desktop app: https://github.com/jgraph/drawio-desktop

DRAWIO_BIN="/Applications/draw.io.app/Contents/MacOS/draw.io"
if [ ! -x "$DRAWIO_BIN" ]; then
  echo "draw.io not found at $DRAWIO_BIN — skipping SVG export"
  exit 0
fi

CHANGED=$(git diff --cached --name-only --diff-filter=ACM | grep '\.drawio$')
if [ -z "$CHANGED" ]; then exit 0; fi

for f in $CHANGED; do
  out="docs/diagrams/$(basename "$f" .drawio).svg"
  echo "Exporting $f → $out"
  "$DRAWIO_BIN" --export --format svg --output "$out" "$f"
  git add "$out"
done
EOF
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
```

**Step 4: Create `README.md`**

```markdown
# nakom-admin

Admin dashboard for [nakom.is](https://nakom.is) — chat analytics, on-demand RDS/pgvector, spam detection and blocking.

**Live:** https://admin.nakom.is
**Account:** nakom.is-admin (AWS eu-west-2)
**Licence:** CC0-1.0

## Architecture

<!-- drawio: docs/diagrams/architecture.drawio -->
![Architecture](docs/diagrams/architecture.svg)

## Stack deploy order

```
CertificateStack (us-east-1) → CognitoStack → CloudfrontStack → AnalyticsStack → ApiStack
```

## Development

```bash
# Infra
cd infra && npm install
AWS_PROFILE=nakom.is-admin cdk synth

# Web app
cd web && npm install && npm start
```

## Git hooks

draw.io files are auto-exported to SVG on commit. Activate with:

```bash
git config core.hooksPath .githooks
```
```

**Step 5: Commit**

```bash
git add .
git commit -m "chore: initial repo scaffold with draw.io git hook and README"
```

---

## Phase 3: nakom-admin — CDK Infrastructure

### Task 8: infra project setup

**Files:**
- Create: `infra/package.json`, `infra/tsconfig.json`, `infra/cdk.json`, `infra/bin/infra.ts`

**Step 1: Initialise CDK project**

```bash
cd infra
npm init -y
npm install aws-cdk-lib constructs
npm install -D aws-cdk typescript @types/node ts-node ts-jest @types/jest jest
```

**`infra/tsconfig.json`** — copy from nakom.is project root.

**`infra/cdk.json`**:
```json
{
  "app": "npx ts-node bin/infra.ts",
  "context": {
    "@aws-cdk/aws-lambda:recognizeLayerVersion": true
  }
}
```

**`infra/bin/infra.ts`** skeleton:

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';

const app = new cdk.App();
const londonEnv = { env: { account: '637423226886', region: 'eu-west-2' } };
const nvirginiaEnv = { env: { account: '637423226886', region: 'us-east-1' } };

// Stacks added in subsequent tasks
cdk.Tags.of(app).add('MH-Project', 'nakom-admin');
```

**Step 2: Verify synth runs**

```bash
AWS_PROFILE=nakom.is-admin cdk synth
```

Expected: empty assembly, no errors.

**Step 3: Commit**

```bash
git add infra/
git commit -m "chore(infra): CDK project setup"
```

---

### Task 9: CertificateStack and CognitoStack

**Files:**
- Create: `infra/lib/certificate-stack.ts`
- Create: `infra/lib/cognito-stack.ts`
- Modify: `infra/bin/infra.ts`

**Step 1: CertificateStack**

```typescript
// infra/lib/certificate-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class CertificateStack extends cdk.Stack {
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // Look up the existing nakom.is hosted zone (managed in nakom.is project)
    const zone = route53.HostedZone.fromLookup(this, 'NakomIsZone', {
      domainName: 'nakom.is',
    });

    this.certificate = new acm.Certificate(this, 'AdminCert', {
      domainName: 'admin.nakom.is',
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}
```

**Step 2: CognitoStack**

```typescript
// infra/lib/cognito-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class CognitoStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly identityPool: cognito.CfnIdentityPool;
  readonly authenticatedRole: iam.Role;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: 'nakom-admin-users',
      selfSignUpEnabled: false,          // invite-only
      signInAliases: { username: true, email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { totp: true, sms: false },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('AdminWebClient', {
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ['https://admin.nakom.is/loggedin', 'http://localhost:5173/loggedin'],
        logoutUrls: ['https://admin.nakom.is/logout', 'http://localhost:5173/logout'],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    const cognitoDomain = this.userPool.addDomain('AdminCognitoDomain', {
      cognitoDomain: { domainPrefix: 'auth-nakom-admin' },
    });

    this.identityPool = new cognito.CfnIdentityPool(this, 'AdminIdentityPool', {
      identityPoolName: 'nakom_admin_identity',
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [{
        clientId: this.userPoolClient.userPoolClientId,
        providerName: this.userPool.userPoolProviderName,
      }],
    });

    this.authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': this.identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoles', {
      identityPoolId: this.identityPool.ref,
      roles: { authenticated: this.authenticatedRole.roleArn },
    });
  }
}
```

**Step 3: Wire into bin/infra.ts**

```typescript
import { CertificateStack } from '../lib/certificate-stack';
import { CognitoStack } from '../lib/cognito-stack';

const certStack = new CertificateStack(app, 'AdminCertStack', {
  ...nvirginiaEnv,
  crossRegionReferences: true,
});

const cognitoStack = new CognitoStack(app, 'AdminCognitoStack', londonEnv);
```

**Step 4: Deploy**

```bash
AWS_PROFILE=nakom.is-admin cdk deploy AdminCertStack AdminCognitoStack
```

**Step 5: Create Martin's admin user manually**

```bash
AWS_PROFILE=nakom.is-admin aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId from output> \
  --username martin \
  --user-attributes Name=email,Value=<martinEmail> \
  --temporary-password "<TempPassword>" \
  --region eu-west-2
```

**Step 6: Commit**

```bash
git add infra/lib/certificate-stack.ts infra/lib/cognito-stack.ts infra/bin/infra.ts
git commit -m "feat(infra): CertificateStack and CognitoStack for admin.nakom.is"
```

---

### Task 10: AnalyticsStack — VPC + RDS

**Files:**
- Create: `infra/lib/analytics-stack.ts`

**Architecture note:** No NAT Gateway. VPC uses `PRIVATE_ISOLATED` subnets. S3 Gateway VPC endpoint (free) lets in-VPC Lambdas read/write S3 without internet. RDS credentials stored in Secrets Manager; passed to in-VPC Lambdas via CloudFormation dynamic references (Lambda env vars support `{{resolve:secretsmanager:...}}`). Out-of-VPC Lambdas (embedding generation, RDS start/stop) call AWS APIs directly. All RDS-querying Lambdas live in the VPC.

```typescript
// infra/lib/analytics-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export class AnalyticsStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly dbInstance: rds.DatabaseInstance;
  readonly dbSecret: rds.DatabaseSecret;
  readonly stagingBucket: s3.Bucket;
  readonly rdsSecurityGroup: ec2.SecurityGroup;
  readonly lambdaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // VPC — no NAT, isolated private subnets only
    this.vpc = new ec2.Vpc(this, 'AnalyticsVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        name: 'Private',
        cidrMask: 24,
      }],
    });

    // Free S3 Gateway endpoint — allows in-VPC Lambdas to reach S3
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Security groups
    this.rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc: this.vpc,
      description: 'nakom-admin RDS PostgreSQL',
      allowAllOutbound: false,
    });

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'nakom-admin VPC Lambdas',
      allowAllOutbound: true,
    });

    this.rdsSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow VPC Lambdas to connect to PostgreSQL',
    );

    // RDS credentials (stored in Secrets Manager, resolved at CloudFormation deploy time)
    this.dbSecret = new rds.DatabaseSecret(this, 'DbSecret', {
      username: 'analytics',
      secretName: 'nakom-admin/rds/analytics',
    });

    // RDS t4g.micro PostgreSQL 16
    this.dbInstance = new rds.DatabaseInstance(this, 'AnalyticsDb', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      databaseName: 'analytics',
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.rdsSecurityGroup],
      multiAz: false,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP2,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Disable automated backups (instance is stopped most of the time;
      // we use manual snapshots from the admin app instead)
      backupRetention: cdk.Duration.days(0),
      // CloudWatch alarm: stop instance if running > 12h unexpectedly
    });

    // S3 staging bucket: import-generate Lambda writes embedding JSON here;
    // import-execute Lambda (in VPC) reads it via the Gateway endpoint
    this.stagingBucket = new s3.Bucket(this, 'StagingBucket', {
      bucketName: 'nakomis-analytics-staging',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{
        // Clean up staging files after 1 day
        expiration: cdk.Duration.days(1),
        prefix: 'import-staging/',
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // SSM params for out-of-VPC Lambdas to find the RDS instance
    new ssm.StringParameter(this, 'DbEndpointParam', {
      parameterName: '/nakom-admin/rds/endpoint',
      stringValue: this.dbInstance.dbInstanceEndpointAddress,
    });
    new ssm.StringParameter(this, 'DbSecretArnParam', {
      parameterName: '/nakom-admin/rds/secret-arn',
      stringValue: this.dbSecret.secretArn,
    });
    new ssm.StringParameter(this, 'DbInstanceIdParam', {
      parameterName: '/nakom-admin/rds/instance-id',
      stringValue: this.dbInstance.instanceIdentifier,
    });
    new ssm.StringParameter(this, 'StagingBucketParam', {
      parameterName: '/nakom-admin/staging-bucket',
      stringValue: this.stagingBucket.bucketName,
    });
  }
}
```

**Deploy:**

```bash
AWS_PROFILE=nakom.is-admin cdk deploy AdminAnalyticsStack
```

**Commit:**

```bash
git add infra/lib/analytics-stack.ts infra/bin/infra.ts
git commit -m "feat(infra): AnalyticsStack — VPC, RDS t4g.micro/pgvector, staging S3"
```

---

### Task 11: CloudfrontStack + Route53 record

**Files:**
- Create: `infra/lib/cloudfront-stack.ts`

```typescript
// infra/lib/cloudfront-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { CognitoStack } from './cognito-stack';

export interface CloudfrontStackProps extends cdk.StackProps {
  certificate: acm.Certificate;
  cognitoStack: CognitoStack;
  apiOriginDomain?: string; // set after ApiStack deploys
}

export class CloudfrontStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;
  readonly webBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: CloudfrontStackProps) {
    super(scope, id, props);

    this.webBucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: 'nakomis-admin-web',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const oai = new cloudfront.OriginAccessIdentity(this, 'OAI');
    this.webBucket.grantRead(oai);

    this.distribution = new cloudfront.Distribution(this, 'AdminDistribution', {
      comment: 'nakom-admin',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [{
        // SPA routing — serve index.html for 403/404 so React Router works
        httpStatus: 403,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
      }, {
        httpStatus: 404,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
      }],
      domainNames: ['admin.nakom.is'],
      certificate: props.certificate,
    });

    // Add admin.nakom.is A record to the existing nakom.is hosted zone
    const zone = route53.HostedZone.fromLookup(this, 'NakomIsZone', {
      domainName: 'nakom.is',
    });
    new route53.ARecord(this, 'AdminARecord', {
      zone,
      recordName: 'admin',
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution),
      ),
    });
  }
}
```

**Deploy:**

```bash
AWS_PROFILE=nakom.is-admin cdk deploy AdminCloudfrontStack
```

**Commit:**

```bash
git add infra/lib/cloudfront-stack.ts infra/bin/infra.ts
git commit -m "feat(infra): CloudfrontStack with S3 web hosting and Route53 record"
```

---

### Task 12: ApiStack — API Gateway + all Lambda stubs

**Files:**
- Create: `infra/lib/api-stack.ts`

This task wires up the API Gateway and all six Lambda functions. Actual Lambda implementation is in Tasks 13–18; here we create stubs (functions that return `{ok: true}`) and establish the full IAM grant structure.

Create stub handlers at `infra/lambda/{name}/handler.ts` each containing:
```typescript
export const handler = async () => ({ statusCode: 200, body: '{"ok":true}' });
```

The full `api-stack.ts` establishes:
- API Gateway (HTTP API with Cognito JWT authorizer)
- Six Lambdas with env vars and IAM grants
- Routes: `GET /rds/status`, `POST /rds/start`, `POST /rds/stop`, `POST /rds/snapshot`, `POST /rds/restore`, `GET /rds/snapshots`, `POST /import/generate`, `POST /import/execute`, `GET /query/{type}`, `POST /logs/mine`, `GET /blocklist`, `POST /blocklist`, `DELETE /blocklist/{ip}`

Key IAM grants to wire now:
- `rds-control` Lambda: `rds:StartDBInstance`, `rds:StopDBInstance`, `rds:CreateDBSnapshot`, `rds:DeleteDBSnapshot`, `rds:DescribeDBSnapshots`, `rds:DescribeDBInstances`, `rds:RestoreDBInstanceFromDBSnapshot`
- `import-generate` Lambda: DDB read on `nakomis-chat-logs`, Bedrock `InvokeModel` for `amazon.titan-embed-text-v2:0`, S3 write to staging bucket, SSM read for import cursor, SSM write for import cursor, Lambda invoke for `import-execute`
- `import-execute` Lambda: S3 read from staging bucket (via VPC Gateway endpoint), in VPC config
- `query` Lambda: in VPC config, S3 read for any cached results
- `monitor-logs` Lambda: S3 read from `nakomis-cf-access-logs`, SSM read for bucket name, DDB read on `nakomis-chat-logs`
- `blocklist` Lambda: SSM read/write for `/nakom.is/blocked-ips`, `cloudfront:DescribeFunctions`, `cloudfront:UpdateFunction`, `cloudfront:PublishFunction`

**Deploy:**

```bash
AWS_PROFILE=nakom.is-admin cdk deploy AdminApiStack
```

**Commit:**

```bash
git add infra/lib/api-stack.ts infra/lambda/*/handler.ts infra/bin/infra.ts
git commit -m "feat(infra): ApiStack with API Gateway, Cognito authorizer, and Lambda stubs"
```

---

## Phase 4: nakom-admin — Lambda Implementations

### Task 13: `rds-control` Lambda

**Files:**
- Replace: `infra/lambda/rds-control/handler.ts`

```typescript
import { RDSClient, StartDBInstanceCommand, StopDBInstanceCommand,
  CreateDBSnapshotCommand, DeleteDBSnapshotCommand,
  DescribeDBSnapshotsCommand, DescribeDBInstancesCommand,
  RestoreDBInstanceFromDBSnapshotCommand } from '@aws-sdk/client-rds';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const rds = new RDSClient({});
const ssm = new SSMClient({});
const SNAPSHOTS_TO_KEEP = 4;

async function getInstanceId(): Promise<string> {
  const r = await ssm.send(new GetParameterCommand({ Name: '/nakom-admin/rds/instance-id' }));
  return r.Parameter!.Value!;
}

export const handler = async (event: { action: string }) => {
  const instanceId = await getInstanceId();

  switch (event.action) {
    case 'status': {
      const r = await rds.send(new DescribeDBInstancesCommand({
        DBInstanceIdentifier: instanceId,
      }));
      const db = r.DBInstances?.[0];
      return { status: db?.DBInstanceStatus, endpoint: db?.Endpoint?.Address };
    }

    case 'start':
      await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
      return { ok: true };

    case 'stop':
      await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
      return { ok: true };

    case 'snapshot': {
      const snapshotId = `nakom-admin-${Date.now()}`;
      await rds.send(new CreateDBSnapshotCommand({
        DBInstanceIdentifier: instanceId,
        DBSnapshotIdentifier: snapshotId,
      }));
      // Prune old snapshots — keep SNAPSHOTS_TO_KEEP most recent
      const all = await rds.send(new DescribeDBSnapshotsCommand({
        DBInstanceIdentifier: instanceId,
        SnapshotType: 'manual',
      }));
      const sorted = (all.DBSnapshots ?? [])
        .filter(s => s.Status === 'available')
        .sort((a, b) => (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0));

      for (const old of sorted.slice(SNAPSHOTS_TO_KEEP)) {
        await rds.send(new DeleteDBSnapshotCommand({
          DBSnapshotIdentifier: old.DBSnapshotIdentifier!,
        }));
      }
      return { ok: true, snapshotId };
    }

    case 'snapshots': {
      const r = await rds.send(new DescribeDBSnapshotsCommand({
        DBInstanceIdentifier: instanceId,
        SnapshotType: 'manual',
      }));
      return r.DBSnapshots
        ?.filter(s => s.Status === 'available')
        .sort((a, b) => (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0))
        .map(s => ({ id: s.DBSnapshotIdentifier, createdAt: s.SnapshotCreateTime, sizeGb: s.AllocatedStorage }))
        ?? [];
    }

    case 'restore': {
      // Restore from the most recent available snapshot.
      // RDS restore requires the instance to not exist — this creates a NEW instance from snapshot.
      // For simplicity: stop current, rename, restore snapshot as same name.
      // In practice: just restore from snapshot to a new identifier, update SSM.
      const all = await rds.send(new DescribeDBSnapshotsCommand({
        DBInstanceIdentifier: instanceId,
        SnapshotType: 'manual',
      }));
      const latest = (all.DBSnapshots ?? [])
        .filter(s => s.Status === 'available')
        .sort((a, b) => (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0))[0];
      if (!latest) return { error: 'No snapshots available' };

      const newId = `${instanceId}-restored-${Date.now()}`;
      await rds.send(new RestoreDBInstanceFromDBSnapshotCommand({
        DBInstanceIdentifier: newId,
        DBSnapshotIdentifier: latest.DBSnapshotIdentifier!,
        DBInstanceClass: 'db.t4g.micro',
      }));
      return { ok: true, newInstanceId: newId };
    }

    default:
      return { error: `Unknown action: ${event.action}` };
  }
};
```

**Commit:**

```bash
git add infra/lambda/rds-control/handler.ts
git commit -m "feat(lambda): rds-control — start/stop/snapshot/restore/status"
```

---

### Task 14: `import-generate` Lambda (DDB → Bedrock → S3)

**Files:**
- Replace: `infra/lambda/import-generate/handler.ts`

This Lambda runs **outside** the VPC. It reads unimported DDB records, generates embeddings via Bedrock Titan Embed v2, writes batched JSON to S3, then invokes `import-execute`.

```typescript
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const ddb = new DynamoDBClient({});
const ssm = new SSMClient({});
const bedrock = new BedrockRuntimeClient({ region: 'eu-west-2' });
const s3 = new S3Client({});
const lambdaClient = new LambdaClient({});

const LOG_TYPE = 'CVCHAT';
const CURSOR_PARAM = '/nakom.is/analytics/CVCHAT/last-imported-timestamp';
const EMBED_MODEL = 'amazon.titan-embed-text-v2:0';
const BATCH_SIZE = 25;

async function embedText(text: string): Promise<number[]> {
  const response = await bedrock.send(new InvokeModelCommand({
    modelId: EMBED_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ inputText: text.slice(0, 8000) }), // Titan v2 max 8192 tokens
  }));
  const result = JSON.parse(Buffer.from(response.body).toString());
  return result.embedding as number[];
}

export const handler = async () => {
  const stagingBucket = process.env.STAGING_BUCKET!;
  const executeArn = process.env.IMPORT_EXECUTE_ARN!;

  // Read cursor
  const cursorResult = await ssm.send(new GetParameterCommand({ Name: CURSOR_PARAM }));
  const cursor = cursorResult.Parameter!.Value!;

  // Query unimported records
  const queryResult = await ddb.send(new QueryCommand({
    TableName: 'nakomis-chat-logs',
    KeyConditionExpression: 'logType = :lt AND sk > :cursor',
    ExpressionAttributeValues: {
      ':lt': { S: LOG_TYPE },
      ':cursor': { S: cursor },
    },
    // Skip SMS_SENT sentinel records (they share the same PK)
    FilterExpression: 'attribute_exists(userMessage)',
  }));

  const items = queryResult.Items ?? [];
  if (items.length === 0) return { imported: 0 };

  // Generate embeddings in batches
  const records = [];
  let newCursor = cursor;

  for (const item of items) {
    const userMessage = item.userMessage?.S ?? '';
    const embedding = await embedText(userMessage);

    records.push({
      id: item.sk.S!,
      logType: item.logType.S!,
      conversationId: item.conversationId?.S ?? null,
      ip: item.ip?.S ?? null,
      userAgent: item.userAgent?.S ?? null,
      country: item.country?.S ?? null,
      userMessage,
      messageCount: parseInt(item.messageCount?.N ?? '0'),
      toolsCalled: item.toolsCalled?.SS ?? [],
      inputTokens: parseInt(item.inputTokens?.N ?? '0'),
      outputTokens: parseInt(item.outputTokens?.N ?? '0'),
      durationMs: parseInt(item.durationMs?.N ?? '0'),
      rateLimited: item.rateLimited?.BOOL ?? false,
      embedding,
    });

    // Track the latest SK we've processed
    if (item.sk.S! > newCursor) newCursor = item.sk.S!;
  }

  // Write to S3 staging
  const stagingKey = `import-staging/${Date.now()}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: stagingBucket,
    Key: stagingKey,
    Body: JSON.stringify(records),
    ContentType: 'application/json',
  }));

  // Invoke import-execute Lambda (async, fire-and-forget)
  await lambdaClient.send(new InvokeCommand({
    FunctionName: executeArn,
    InvocationType: 'Event', // async
    Payload: JSON.stringify({ stagingBucket, stagingKey, newCursor }),
  }));

  return { queued: records.length, stagingKey };
};
```

**Commit:**

```bash
git add infra/lambda/import-generate/handler.ts
git commit -m "feat(lambda): import-generate — DDB → Bedrock embeddings → S3 staging"
```

---

### Task 15: `import-execute` Lambda (S3 → RDS, inside VPC)

**Files:**
- Replace: `infra/lambda/import-execute/handler.ts`

This Lambda is **inside** the VPC. It reads the staged JSON from S3 (via Gateway endpoint), bulk-inserts into pgvector, then updates the SSM cursor. The RDS connection string comes from Lambda env vars (CloudFormation dynamic references resolved at deploy time).

Add dependency: `npm install pg` in the lambda directory (CDK NodejsFunction bundles it).

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { Client as PgClient } from 'pg';

const s3 = new S3Client({ region: process.env.AWS_REGION });
// SSM is NOT reachable from isolated VPC subnet — cursor update passed as event param
// and the import-generate Lambda handles SSM. import-execute only writes to RDS.

async function getS3Json(bucket: string, key: string): Promise<any[]> {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await r.Body!.transformToString('utf-8');
  return JSON.parse(body);
}

let pgClient: PgClient | null = null;

async function getDb(): Promise<PgClient> {
  if (pgClient) return pgClient;
  pgClient = new PgClient({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT ?? '5432'),
    database: process.env.DB_NAME ?? 'analytics',
    user: process.env.DB_USER ?? 'analytics',
    password: process.env.DB_PASS,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  await pgClient.connect();

  // Bootstrap schema on first connection
  await pgClient.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS chat_logs (
      id            TEXT PRIMARY KEY,
      log_type      TEXT NOT NULL,
      conversation_id TEXT,
      recorded_at   TIMESTAMPTZ NOT NULL,
      ip            TEXT,
      user_agent    TEXT,
      country       TEXT,
      user_message  TEXT,
      message_count INT,
      tools_called  TEXT[],
      input_tokens  INT,
      output_tokens INT,
      duration_ms   INT,
      rate_limited  BOOLEAN,
      embedding     vector(1536)
    )
  `);
  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS chat_logs_embedding_idx
    ON chat_logs USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100)
  `);

  return pgClient;
}

export const handler = async (event: {
  stagingBucket: string;
  stagingKey: string;
  newCursor: string;
}) => {
  const records = await getS3Json(event.stagingBucket, event.stagingKey);
  const db = await getDb();

  // Bulk insert with ON CONFLICT DO NOTHING (idempotent)
  for (const r of records) {
    // Extract timestamp from sk (format: "2026-02-26T10:15:00.000Z#uuid")
    const recordedAt = r.id.split('#')[0];
    const embeddingLiteral = `[${r.embedding.join(',')}]`;

    await db.query(`
      INSERT INTO chat_logs (id, log_type, conversation_id, recorded_at, ip, user_agent,
        country, user_message, message_count, tools_called, input_tokens, output_tokens,
        duration_ms, rate_limited, embedding)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector)
      ON CONFLICT (id) DO NOTHING
    `, [r.id, r.logType, r.conversationId, recordedAt, r.ip, r.userAgent,
        r.country, r.userMessage, r.messageCount, r.toolsCalled,
        r.inputTokens, r.outputTokens, r.durationMs, r.rateLimited,
        embeddingLiteral]);
  }

  // NOTE: cursor update is handled by import-generate Lambda after this invocation
  // returns successfully. import-generate listens via a callback pattern, or (simpler)
  // import-generate sets the cursor AFTER invoking this Lambda synchronously.
  // For async invocation: import-generate should update cursor in a follow-up step
  // or accept eventual consistency (re-importing already-imported records is idempotent).

  return { inserted: records.length };
};
```

**Important note on cursor safety:** For async invocation (`InvocationType: 'Event'`), update the SSM cursor in `import-generate` only *before* invoking `import-execute`. If `import-execute` fails, the cursor won't advance, and the next import run will re-process the same records — which is safe because of `ON CONFLICT DO NOTHING`.

**Commit:**

```bash
git add infra/lambda/import-execute/handler.ts
git commit -m "feat(lambda): import-execute — S3 staged records bulk-inserted to pgvector (VPC)"
```

---

### Task 16: `query` Lambda (analytics queries, inside VPC)

**Files:**
- Replace: `infra/lambda/query/handler.ts`

```typescript
import { Client as PgClient } from 'pg';

// Reuse DB connection across warm invocations
let pgClient: PgClient | null = null;
async function getDb(): Promise<PgClient> {
  if (pgClient) return pgClient;
  pgClient = new PgClient({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT ?? '5432'),
    database: process.env.DB_NAME ?? 'analytics', user: process.env.DB_USER ?? 'analytics',
    password: process.env.DB_PASS, ssl: { rejectUnauthorized: false },
  });
  await pgClient.connect();
  return pgClient;
}

export const handler = async (event: { queryType: string; params?: any }) => {
  const db = await getDb();

  switch (event.queryType) {
    case 'similarity_graph': {
      // Returns pairs of chat_log IDs with cosine similarity above threshold
      const threshold = event.params?.threshold ?? 0.85;
      const limit = event.params?.limit ?? 500;
      const rows = await db.query(`
        SELECT a.id AS id_a, b.id AS id_b,
               1 - (a.embedding <=> b.embedding) AS similarity,
               a.user_message AS msg_a, b.user_message AS msg_b,
               a.ip AS ip_a, b.ip AS ip_b
        FROM chat_logs a
        JOIN chat_logs b ON a.id < b.id
        WHERE 1 - (a.embedding <=> b.embedding) > $1
        LIMIT $2
      `, [threshold, limit]);
      return rows.rows;
    }

    case 'nodes': {
      // All chat log nodes for the graph (without embeddings — too large)
      const rows = await db.query(`
        SELECT id, conversation_id, recorded_at, ip, country,
               user_message, message_count, tools_called,
               input_tokens + output_tokens AS total_tokens
        FROM chat_logs
        ORDER BY recorded_at DESC
        LIMIT 1000
      `);
      return rows.rows;
    }

    case 'tool_usage': {
      const rows = await db.query(`
        SELECT unnest(tools_called) AS tool, count(*) AS uses
        FROM chat_logs
        WHERE tools_called IS NOT NULL
        GROUP BY 1
        ORDER BY 2 DESC
      `);
      return rows.rows;
    }

    case 'ip_activity': {
      const rows = await db.query(`
        SELECT ip,
               count(*) AS total_requests,
               count(DISTINCT DATE(recorded_at)) AS active_days,
               min(recorded_at) AS first_seen,
               max(recorded_at) AS last_seen,
               sum(CASE WHEN rate_limited THEN 1 ELSE 0 END) AS rate_limit_hits
        FROM chat_logs
        WHERE ip != 'unknown'
        GROUP BY ip
        ORDER BY total_requests DESC
        LIMIT 200
      `);
      return rows.rows;
    }

    case 'conversations': {
      const rows = await db.query(`
        SELECT conversation_id, count(*) AS turns,
               min(recorded_at) AS started, max(recorded_at) AS ended,
               array_agg(user_message ORDER BY recorded_at) AS messages
        FROM chat_logs
        WHERE conversation_id IS NOT NULL
        GROUP BY conversation_id
        ORDER BY started DESC
        LIMIT 100
      `);
      return rows.rows;
    }

    default:
      return { error: `Unknown queryType: ${event.queryType}` };
  }
};
```

**Commit:**

```bash
git add infra/lambda/query/handler.ts
git commit -m "feat(lambda): query — similarity graph, tool usage, IP activity, conversations"
```

---

### Task 17: `monitor-logs` Lambda (CloudFront log miner)

**Files:**
- Replace: `infra/lambda/monitor-logs/handler.ts`

CloudFront access logs are gzip-compressed TSV files in S3. Each line is a request. The Lambda parses them and aggregates bad-actor signals.

```typescript
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Writable } from 'stream';
import * as readline from 'readline';

const s3 = new S3Client({});

// CloudFront log field indices (0-based, after stripping the 2 header lines)
const CF_DATE = 0, CF_TIME = 1, CF_IP = 4, CF_METHOD = 5,
  CF_STATUS = 8, CF_URI_STEM = 7, CF_UA = 10;

const SCANNER_PATHS = ['.env', 'wp-admin', 'wp-login', 'phpmyadmin', '.git',
  'xmlrpc', 'shell.php', 'config.php', 'admin.php', '.aws'];

function isScanner(uri: string): boolean {
  return SCANNER_PATHS.some(p => uri.toLowerCase().includes(p));
}

export const handler = async (event: { days?: number }) => {
  const bucket = process.env.CF_LOGS_BUCKET!;
  const days = event.days ?? 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // List log files in time range
  const files: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: 'cf-logs/',
      ContinuationToken: token,
    }));
    for (const obj of r.Contents ?? []) {
      if (obj.LastModified && obj.LastModified >= since) {
        files.push(obj.Key!);
      }
    }
    token = r.NextContinuationToken;
  } while (token);

  // Aggregate by IP
  const ipStats = new Map<string, {
    total: number; scannerHits: number; errors: number; methods: Set<string>;
  }>();

  for (const key of files) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const lines: string[] = [];
    const gunzip = createGunzip();
    const rl = readline.createInterface({ input: obj.Body!.pipe(gunzip) as any });

    for await (const line of rl) {
      if (line.startsWith('#')) continue; // CF log header lines
      const fields = line.split('\t');
      const ip = fields[CF_IP];
      const uri = fields[CF_URI_STEM] ?? '';
      const status = parseInt(fields[CF_STATUS] ?? '200');
      if (!ip || ip === '-') continue;

      const stats = ipStats.get(ip) ?? { total: 0, scannerHits: 0, errors: 0, methods: new Set() };
      stats.total++;
      if (isScanner(uri)) stats.scannerHits++;
      if (status >= 400) stats.errors++;
      stats.methods.add(fields[CF_METHOD] ?? 'GET');
      ipStats.set(ip, stats);
    }
  }

  // Score and rank
  const results = Array.from(ipStats.entries())
    .map(([ip, s]) => ({
      ip,
      totalRequests: s.total,
      scannerHitRate: s.total > 0 ? s.scannerHits / s.total : 0,
      errorRate: s.total > 0 ? s.errors / s.total : 0,
      flags: [
        s.scannerHits > 0 ? 'SCANNER' : null,
        s.total > 500 ? 'HIGH_VOLUME' : null,
      ].filter(Boolean),
    }))
    .filter(r => r.flags.length > 0 || r.totalRequests > 100)
    .sort((a, b) => b.totalRequests - a.totalRequests)
    .slice(0, 50);

  return { period: `last ${days} days`, filesScanned: files.length, suspects: results };
};
```

**Commit:**

```bash
git add infra/lambda/monitor-logs/handler.ts
git commit -m "feat(lambda): monitor-logs — CloudFront access log miner for bad actor detection"
```

---

### Task 18: `blocklist` Lambda (SSM + CloudFront Function redeployment)

**Files:**
- Replace: `infra/lambda/blocklist/handler.ts`

```typescript
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { CloudFrontClient, DescribeFunctionCommand,
  UpdateFunctionCommand, PublishFunctionCommand } from '@aws-sdk/client-cloudfront';

const ssm = new SSMClient({});
const cf = new CloudFrontClient({ region: 'us-east-1' }); // CF API is global, uses us-east-1

const PARAM_NAME = '/nakom.is/blocked-ips';
const CF_FUNCTION_NAME = 'nakomis-social-redirect';
const MAX_PARAM_BYTES = 3500; // SSM standard limit is 4096; leave headroom

interface BlockEntry { ip: string; blockedAt: string; reason: string; }

async function readBlocklist(): Promise<BlockEntry[]> {
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: PARAM_NAME }));
    return JSON.parse(r.Parameter!.Value!);
  } catch {
    return [];
  }
}

async function writeBlocklist(entries: BlockEntry[]): Promise<void> {
  // FIFO pruning: if serialised size exceeds limit, remove oldest entries first
  let sorted = [...entries].sort((a, b) =>
    new Date(a.blockedAt).getTime() - new Date(b.blockedAt).getTime()
  );
  while (JSON.stringify(sorted).length > MAX_PARAM_BYTES && sorted.length > 0) {
    sorted.shift(); // remove oldest (FIFO)
  }
  await ssm.send(new PutParameterCommand({
    Name: PARAM_NAME,
    Value: JSON.stringify(sorted),
    Type: 'String',
    Overwrite: true,
  }));
}

function renderCfFunction(blockedIps: string[]): string {
  const ipSet = JSON.stringify(blockedIps);
  return `
function handler(event) {
    var BLOCKED = ${ipSet};
    var ip = (event.request.headers['x-forwarded-for'] || {value:''}).value.split(',')[0].trim();
    if (BLOCKED.indexOf(ip) !== -1) {
        return { statusCode: 403, statusDescription: 'Forbidden' };
    }
    var uri = event.request.uri;
    if (uri === '/social' || uri === '/social/') {
        return { statusCode: 301, statusDescription: 'Moved Permanently',
                 headers: { location: { value: '/' } } };
    }
    if (uri === '/') { event.request.uri = '/social'; }
    return event.request;
}`.trim();
}

async function redeployCfFunction(blockedIps: string[]): Promise<void> {
  // Get current ETag
  const desc = await cf.send(new DescribeFunctionCommand({ Name: CF_FUNCTION_NAME, Stage: 'LIVE' }));
  const etag = desc.ETag!;

  const code = renderCfFunction(blockedIps);
  const updated = await cf.send(new UpdateFunctionCommand({
    Name: CF_FUNCTION_NAME,
    IfMatch: etag,
    FunctionConfig: { Comment: 'Social redirect + IP block', Runtime: 'cloudfront-js-2.0' },
    FunctionCode: Buffer.from(code),
  }));

  await cf.send(new PublishFunctionCommand({
    Name: CF_FUNCTION_NAME,
    IfMatch: updated.ETag!,
  }));
}

export const handler = async (event: {
  action: 'list' | 'add' | 'remove';
  ip?: string;
  reason?: string;
}) => {
  const entries = await readBlocklist();

  if (event.action === 'list') {
    // Return in reverse-chronological order (newest first)
    return entries.slice().sort((a, b) =>
      new Date(b.blockedAt).getTime() - new Date(a.blockedAt).getTime()
    );
  }

  if (event.action === 'add' && event.ip) {
    if (entries.some(e => e.ip === event.ip)) return { ok: true, alreadyBlocked: true };
    entries.push({ ip: event.ip, blockedAt: new Date().toISOString(), reason: event.reason ?? '' });
    await writeBlocklist(entries);
    await redeployCfFunction(entries.map(e => e.ip));
    return { ok: true, blocked: event.ip };
  }

  if (event.action === 'remove' && event.ip) {
    const filtered = entries.filter(e => e.ip !== event.ip);
    await writeBlocklist(filtered);
    await redeployCfFunction(filtered.map(e => e.ip));
    return { ok: true, unblocked: event.ip };
  }

  return { error: 'Invalid action' };
};
```

**Commit:**

```bash
git add infra/lambda/blocklist/handler.ts
git commit -m "feat(lambda): blocklist — SSM-backed IP list, FIFO pruning, CF Function redeploy"
```

---

## Phase 5: nakom-admin — React Web App

### Task 19: Scaffold the web app (copy sandbox styling)

**Files:**
- Create: `web/` directory, Vite project

```bash
cd web
npm create vite@latest . -- --template react-ts
npm install
npm install @mui/material @mui/icons-material @emotion/react @emotion/styled
npm install react-oidc-context oidc-client-ts
npm install @aws-sdk/client-cognito-identity
npm install d3
npm install @types/d3 -D
```

**Step 1: Copy sandbox MUI theme**

Create `web/src/theme.ts` copying the dark theme from the sandbox `App.tsx`:

```typescript
import { createTheme } from '@mui/material/styles';
import { blue, green } from '@mui/material/colors';

export const theme = createTheme({
  typography: {
    fontFamily: ['Roboto', 'Helvetica', 'Arial', 'sans-serif'].join(','),
    fontSize: 24,
  },
  palette: {
    mode: 'dark',
    text: { secondary: '#585c64' },
    primary: { main: blue['A700'] },
    secondary: { main: green[900] },
    background: { default: '#ffffff', paper: '#1e1e1e' },
  },
});
```

**Step 2: Create `web/src/config/config.ts`**

```typescript
export interface AdminConfig {
  aws: { region: string };
  cognito: {
    authority: string; userPoolId: string; userPoolClientId: string;
    cognitoDomain: string; redirectUri: string; logoutUri: string;
    identityPoolId: string;
  };
  apiEndpoint: string;
}

import configJson from './config.json';
const Config = configJson as AdminConfig;
export default Config;
```

Create `web/src/config/config.json.template` (gitignored `config.json`):

```json
{
  "aws": { "region": "eu-west-2" },
  "cognito": {
    "authority": "https://cognito-idp.eu-west-2.amazonaws.com/__USER_POOL_ID__",
    "userPoolId": "__USER_POOL_ID__",
    "userPoolClientId": "__CLIENT_ID__",
    "cognitoDomain": "auth-nakom-admin.auth.eu-west-2.amazoncognito.com",
    "redirectUri": "https://admin.nakom.is/loggedin",
    "logoutUri": "https://admin.nakom.is/logout",
    "identityPoolId": "__IDENTITY_POOL_ID__"
  },
  "apiEndpoint": "https://__API_ID__.execute-api.eu-west-2.amazonaws.com/prod"
}
```

**Step 3: `web/scripts/set-config.sh`**

```bash
#!/bin/bash
set -euo pipefail
PROFILE="${AWS_PROFILE:-nakom.is-admin}"
REGION="eu-west-2"

get() { aws cloudformation describe-stacks --stack-name "$1" \
  --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
  --output text --region "$REGION" --profile "$PROFILE"; }

UP=$(get AdminCognitoStack UserPoolId)
CLIENT=$(get AdminCognitoStack UserPoolClientId)
IP=$(get AdminCognitoStack IdentityPoolId)
API=$(get AdminApiStack ApiEndpoint)

sed "s/__USER_POOL_ID__/$UP/g; s/__CLIENT_ID__/$CLIENT/g; \
     s/__IDENTITY_POOL_ID__/$IP/g; s/__API_ID__/$API/g" \
  src/config/config.json.template > src/config/config.json
echo "Config written."
```

**Step 4: `web/scripts/deploy.sh`**

```bash
#!/bin/bash
set -euo pipefail
PROFILE="${AWS_PROFILE:-nakom.is-admin}"
BUCKET="nakomis-admin-web"
DIST_ID=$(aws cloudformation describe-stacks --stack-name AdminCloudfrontStack \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
  --output text --profile "$PROFILE")

npm run build
aws s3 sync dist/ "s3://$BUCKET/" --delete --profile "$PROFILE"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
  --profile "$PROFILE"
echo "Deployed."
```

**Step 5: Commit**

```bash
git add web/
git commit -m "feat(web): scaffold React app with MUI dark theme, Cognito auth, config setup"
```

---

### Task 20: App shell + auth (copied from sandbox pattern)

**Files:**
- Replace: `web/src/App.tsx`

Follow the sandbox `App.tsx` pattern exactly: use `react-oidc-context`, exchange Cognito ID token for AWS credentials via Identity Pool, render tabs. Admin app has a single tab for now: **Analytics**.

The authenticated shell renders:
```
[Analytics] tab in an AppBar  |  Sign out button
```

Key difference from sandbox: no `selectedTab` cookie needed (only one tab initially). Add a `Loading...` and error state identical to sandbox.

**Commit:**

```bash
git add web/src/App.tsx web/src/main.tsx
git commit -m "feat(web): App shell with Cognito auth, identical pattern to sandbox"
```

---

### Task 21: analyticsService.ts — API calls

**Files:**
- Create: `web/src/services/analyticsService.ts`

All API calls go through this service. Pass Cognito ID token as Bearer in Authorization header.

```typescript
import Config from '../config/config';

async function apiCall<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const idToken = (window as any).__oidc_user?.id_token;
  const res = await fetch(`${Config.apiEndpoint}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`API ${method} ${path} → ${res.status}`);
  return res.json();
}

export const AnalyticsService = {
  getRdsStatus: () => apiCall<{ status: string; endpoint?: string }>('/rds/status'),
  startRds: () => apiCall('/rds/start', 'POST'),
  stopRds: () => apiCall('/rds/stop', 'POST'),
  takeSnapshot: () => apiCall('/rds/snapshot', 'POST'),
  listSnapshots: () => apiCall<any[]>('/rds/snapshots'),
  restoreSnapshot: () => apiCall('/rds/restore', 'POST'),
  importGenerate: () => apiCall<{ queued: number }>('/import/generate', 'POST'),
  query: (queryType: string, params?: object) =>
    apiCall<any[]>(`/query/${queryType}`, 'POST', params),
  mineLogs: (days: number) => apiCall<any>('/logs/mine', 'POST', { days }),
  getBlocklist: () => apiCall<any[]>('/blocklist'),
  addToBlocklist: (ip: string, reason: string) =>
    apiCall('/blocklist', 'POST', { ip, reason }),
  removeFromBlocklist: (ip: string) => apiCall(`/blocklist/${ip}`, 'DELETE'),
};
```

**Commit:**

```bash
git add web/src/services/analyticsService.ts
git commit -m "feat(web): analyticsService — typed API calls with Cognito auth"
```

---

### Task 22: AnalyticsPage — RDS control panel + data import

**Files:**
- Create: `web/src/components/pages/AnalyticsPage.tsx` (first section)

Build the top section of the analytics page with the four action buttons. Status polling uses `setInterval` while RDS is starting/stopping.

```
┌─────────────────────────────────────────────────────────┐
│  RDS Status: ● Stopped            [▶ Start RDS]         │
│  Last snapshot: 2026-02-25 14:32  [⟳ Restore snapshot]  │
│  Unimported: 47 records           [↓ Import now]        │
│  Snapshots: 4 kept                [● Backup & Stop]     │
└─────────────────────────────────────────────────────────┘
```

Use MUI `Card`, `Button`, `Chip` (for status dot), `CircularProgress` for the polling state. Status polling: 5s interval while status is `starting` or `stopping`, cleared when `available` or `stopped`.

**Commit:**

```bash
git add web/src/components/pages/AnalyticsPage.tsx
git commit -m "feat(web): AnalyticsPage — RDS control panel with status polling"
```

---

### Task 23: AnalyticsPage — Semantic similarity graph

**Files:**
- Modify: `web/src/components/pages/AnalyticsPage.tsx` (add graph section)
- Create: `web/src/components/SimilarityGraph.tsx`

D3 force-directed graph. Data: `AnalyticsService.query('nodes')` + `AnalyticsService.query('similarity_graph', { threshold })`.

```typescript
// SimilarityGraph.tsx — key structure
import * as d3 from 'd3';
import { useEffect, useRef } from 'react';

interface Node { id: string; userMessage: string; ip: string; }
interface Edge { idA: string; idB: string; similarity: number; }

export default function SimilarityGraph({ nodes, edges, threshold }: {
  nodes: Node[]; edges: Edge[]; threshold: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const width = svgRef.current.clientWidth;
    const height = 600;

    const simulation = d3.forceSimulation(nodes as any)
      .force('link', d3.forceLink(edges).id((d: any) => d.id)
        .distance(d => (1 - (d as any).similarity) * 200))
      .force('charge', d3.forceManyBody().strength(-80))
      .force('center', d3.forceCenter(width / 2, height / 2));

    // Draw edges
    const link = svg.append('g').selectAll('line').data(edges)
      .join('line').attr('stroke', '#444').attr('stroke-opacity', 0.6);

    // Draw nodes — coloured by IP (using d3 scaleOrdinal)
    const colorScale = d3.scaleOrdinal(d3.schemeTableau10);
    const node = svg.append('g').selectAll('circle').data(nodes as any)
      .join('circle')
      .attr('r', 6)
      .attr('fill', (d: any) => colorScale(d.ip))
      .call(d3.drag<SVGCircleElement, any>()
        .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
      );

    // Tooltip
    node.append('title').text((d: any) => `${d.ip}\n${d.userMessage?.slice(0, 80)}`);

    simulation.on('tick', () => {
      link.attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
          .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y);
      node.attr('cx', (d: any) => d.x).attr('cy', (d: any) => d.y);
    });
  }, [nodes, edges]);

  return <svg ref={svgRef} width="100%" height={600} style={{ background: '#1e1e1e' }} />;
}
```

Add a threshold slider (MUI `Slider`, range 0.7–0.99, default 0.85) above the graph. Changing the threshold re-fetches edges.

**Commit:**

```bash
git add web/src/components/SimilarityGraph.tsx web/src/components/pages/AnalyticsPage.tsx
git commit -m "feat(web): D3 semantic similarity force-directed graph with threshold slider"
```

---

### Task 24: AnalyticsPage — Tool usage, IP heatmap, log mining, blocklist

**Files:**
- Modify: `web/src/components/pages/AnalyticsPage.tsx`
- Create: `web/src/components/ToolUsageChart.tsx`
- Create: `web/src/components/IpActivityTable.tsx`
- Create: `web/src/components/LogMiner.tsx`
- Create: `web/src/components/BlocklistPanel.tsx`

**Tool usage:** MUI horizontal bar chart (plain `Box` + CSS width %, sorted by count). Two columns: tool name, usage count, and a visual bar. Below the chart, flag messages where `tools_called` is empty and the message is non-trivial length — these are potential "missing tool" signals.

**IP activity table:** MUI `DataGrid`-style table (or plain `Table`) showing IP, total requests, active days, first/last seen, rate limit hits. A `[+ Block]` button on each row that calls `AnalyticsService.addToBlocklist`.

**Log miner:** Two buttons — "Last 7 days" / "Last 30 days". Calls `AnalyticsService.mineLogs(days)`. Results shown as a ranked table with flag chips (SCANNER, HIGH_VOLUME, RATE_LIMIT_ABUSER). Each row has a `[+ Block]` button.

**Blocklist panel:** Shows current blocklist (newest first). Each entry shows IP, `blockedAt` date, reason. `[Unblock]` button calls `AnalyticsService.removeFromBlocklist`. A text field + button to manually add an IP.

**Commit:**

```bash
git add web/src/components/Tool*.tsx web/src/components/Ip*.tsx \
         web/src/components/LogMiner.tsx web/src/components/BlocklistPanel.tsx \
         web/src/components/pages/AnalyticsPage.tsx
git commit -m "feat(web): tool usage chart, IP activity, log miner, blocklist management"
```

---

### Task 25: End-to-end smoke test and deploy

**Step 1: Run set-config.sh**

```bash
cd web && AWS_PROFILE=nakom.is-admin bash scripts/set-config.sh
```

**Step 2: Local dev test**

```bash
npm start
# Visit http://localhost:5173 — should land on Cognito login
# Sign in with the admin user created in Task 9 Step 5
# Verify tabs render, RDS status fetches, no console errors
```

**Step 3: Deploy to production**

```bash
AWS_PROFILE=nakom.is-admin bash scripts/deploy.sh
```

**Step 4: Verify end-to-end**

1. Visit `https://admin.nakom.is` — Cognito login should appear
2. Sign in — analytics page should load
3. Click "Start RDS" — status should change to `starting`
4. Wait ~3 minutes — status should become `available`
5. Click "Import now" — should return `queued: N`
6. Click "Backup & Stop" — snapshot appears in Snapshots list, status changes to `stopping`
7. Send a chat on `nakom.is`, then query DDB to confirm the new record appeared

**Step 5: Final commit and tag**

```bash
git add .
git commit -m "feat: initial admin.nakom.is release — chat analytics and spam blocking"
git tag v1.0.0
git push origin main --tags
```

---

## Appendix: Secrets additions required

`secrets.json` in the nakom.is project needs one new field:

```json
{
  "anthropicApiKey": "...",
  "martinEmail": "...",
  "martinMobile": "+447XXXXXXXXX"
}
```

Update `secrets.json.template` accordingly.

---

## Deploy summary (full stack from scratch)

```bash
# nakom.is account — existing project
AWS_PROFILE=nakom.is-admin cdk deploy ChatStack CloudfrontStack

# nakom-admin — new project
cd nakom-admin/infra
AWS_PROFILE=nakom.is-admin cdk deploy AdminCertStack    # us-east-1
AWS_PROFILE=nakom.is-admin cdk deploy AdminCognitoStack AdminAnalyticsStack AdminCloudfrontStack AdminApiStack

cd ../web
bash scripts/set-config.sh && npm run build && bash scripts/deploy.sh
```
