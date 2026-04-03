import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as fs from 'fs';
import * as path from 'path';

function loadSecrets(): { anthropicApiKey: string; martinEmail: string } {
    const secretsPath = path.join(__dirname, '..', 'secrets.json');
    if (!fs.existsSync(secretsPath)) {
        throw new Error(
            `secrets.json not found at ${secretsPath}\n` +
            `Copy secrets.json.template to secrets.json and fill in your values.\n` +
            `This file is .gitignored and will not be committed.`
        );
    }
    const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
    if (!secrets.anthropicApiKey || secrets.anthropicApiKey.startsWith('sk-ant-api03-YOUR')) {
        throw new Error(
            `secrets.json contains a placeholder API key.\n` +
            `Please replace it with your actual Anthropic API key.`
        );
    }
    if (!secrets.martinEmail || secrets.martinEmail.includes('your-email@')) {
        throw new Error(
            `secrets.json is missing a valid martinEmail.\n` +
            `Please add your email address so the chat widget can contact you.`
        );
    }
    return secrets;
}

export interface ChatStackProps extends cdk.StackProps {
    sesIdentity: ses.EmailIdentity;
    sesFromAddress: string;
    privateBucket: s3.Bucket;
}

export class ChatStack extends cdk.Stack {
    readonly chatFunction: NodejsFunction;
    readonly streamChatFunction: NodejsFunction;
    readonly streamFunctionUrl: lambda.FunctionUrl;
    readonly blogSearchFunction: NodejsFunction;

    constructor(scope: Construct, id: string, props: ChatStackProps) {
        super(scope, id, props);

        const secrets = loadSecrets();

        // Blog bucket (separate CDK app — reference by name, no cross-stack dependency)
        const blogBucket = s3.Bucket.fromBucketName(
            this, 'BlogBucket',
            `blog-nakom-is-${this.region}-${this.account}`
        );

        // SSM Parameter for Anthropic API key
        const anthropicApiKeyParam = new ssm.StringParameter(this, 'AnthropicApiKey', {
            parameterName: '/nakom.is/anthropic-api-key',
            description: 'Anthropic API key for nakom.is chat feature',
            stringValue: secrets.anthropicApiKey,
        });

        // DynamoDB Table for blog chunk metadata (text fetched after cosine search)
        const blogChunksTable = new dynamodb.TableV2(this, 'BlogChunks', {
            tableName:    'blog-chunks',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            billing:      dynamodb.Billing.onDemand(),
        });

        // DynamoDB Table for rate limiting
        const rateLimitTable = new dynamodb.TableV2(this, 'ChatRateLimits', {
            tableName: 'chat-rate-limits',
            partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
            timeToLiveAttribute: 'expiry',
        });

        // DynamoDB Table for CV chat request logging
        const cvChatLogsTable = new dynamodb.TableV2(this, 'CvChatLogs', {
            tableName: 'cv-chat-logs',
            partitionKey: { name: 'logType', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
            timeToLiveAttribute: 'ttl',
            billing: dynamodb.Billing.onDemand(),
        });

        // SSM cursor for analytics import - last timestamp successfully imported to RDS analytics DB
        new ssm.StringParameter(this, 'CvChatImportCursor', {
            parameterName: '/nakom.is/analytics/CVCHAT/last-imported-timestamp',
            description: 'Timestamp of last CV chat record imported to RDS analytics DB',
            stringValue: '1970-01-01T00:00:00.000Z',
        });

        // Log Group
        const logGroup = new LogGroup(this, 'ChatLambdaLogs', {
            logGroupName: '/nakom.is/lambda/chat',
            retention: RetentionDays.SIX_MONTHS,
        });

        // Chat Lambda Function (esbuild bundled by CDK)
        this.chatFunction = new NodejsFunction(this, 'ChatFunction', {
            functionName: 'nakomis-chat',
            entry: 'lambda/chat/handler.ts',
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_20_X,
            memorySize: 256,
            timeout: Duration.seconds(30),
            logGroup: logGroup,
            environment: {
                DAILY_RATE_LIMIT: '100',
                GITHUB_USER: 'nakomis',
                RATE_LIMIT_TABLE: rateLimitTable.tableName,
                MARTIN_EMAIL: secrets.martinEmail,
                SES_FROM_EMAIL: props.sesFromAddress,
                PRIVATE_BUCKET: props.privateBucket.bucketName,
                BLOG_BUCKET: blogBucket.bucketName,
                CV_CHAT_LOGS_TABLE: cvChatLogsTable.tableName,
                BLOG_CHUNKS_TABLE: blogChunksTable.tableName,
            },
            bundling: {
                minify: true,
                sourceMap: true,
            },
        });

        // Grant DynamoDB access
        rateLimitTable.grant(this.chatFunction, 'dynamodb:UpdateItem');
        cvChatLogsTable.grant(this.chatFunction, 'dynamodb:PutItem');
        blogChunksTable.grant(this.chatFunction, 'dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem');

        // Grant SSM read access for the Anthropic API key
        anthropicApiKeyParam.grantRead(this.chatFunction);

        // Grant SES send permission for the nakom.is domain identity and any
        // individually-verified @nakom.is email addresses in this account.
        // SES checks IAM against the most specific matching identity — if the
        // recipient address is individually verified (e.g. aisocial@nakom.is)
        // SES may check that identity's ARN rather than the domain ARN.
        this.chatFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ses:SendEmail'],
            resources: [
                props.sesIdentity.emailIdentityArn,
                `arn:${this.partition}:ses:${this.region}:${this.account}:identity/*@nakom.is`,
            ],
        }));

        // Grant read access to private bucket for CV, LinkedIn, interests, and blog embeddings
        props.privateBucket.grantRead(this.chatFunction, 'cv.md');
        props.privateBucket.grantRead(this.chatFunction, 'linkedin.md');
        props.privateBucket.grantRead(this.chatFunction, 'interests.md');
        props.privateBucket.grantRead(this.chatFunction, 'blog-embeddings.json');

        // Grant read access to blog bucket for blog posts
        blogBucket.grantRead(this.chatFunction, 'posts/*');

        // Grant Bedrock InvokeModel for Titan Embed (query-time embedding)
        this.chatFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel'],
            resources: ['arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0'],
        }));

        // --- Streaming Chat Lambda (SSE via Function URL) ---
        const streamLogGroup = new LogGroup(this, 'StreamChatLambdaLogs', {
            logGroupName: '/nakom.is/lambda/chat-stream',
            retention: RetentionDays.SIX_MONTHS,
        });

        this.streamChatFunction = new NodejsFunction(this, 'StreamChatFunction', {
            functionName: 'nakomis-chat-stream',
            entry: 'lambda/chat/stream-handler.ts',
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_20_X,
            memorySize: 256,
            timeout: Duration.seconds(60),
            logGroup: streamLogGroup,
            environment: {
                DAILY_RATE_LIMIT: '100',
                GITHUB_USER: 'nakomis',
                RATE_LIMIT_TABLE: rateLimitTable.tableName,
                PRIVATE_BUCKET: props.privateBucket.bucketName,
                BLOG_BUCKET: blogBucket.bucketName,
                CV_CHAT_LOGS_TABLE: cvChatLogsTable.tableName,
                BLOG_CHUNKS_TABLE: blogChunksTable.tableName,
            },
            bundling: {
                minify: true,
                sourceMap: true,
            },
        });

        rateLimitTable.grant(this.streamChatFunction, 'dynamodb:UpdateItem');
        cvChatLogsTable.grant(this.streamChatFunction, 'dynamodb:PutItem');
        blogChunksTable.grant(this.streamChatFunction, 'dynamodb:GetItem', 'dynamodb:BatchGetItem');

        anthropicApiKeyParam.grantRead(this.streamChatFunction);
        props.privateBucket.grantRead(this.streamChatFunction, 'cv.md');
        props.privateBucket.grantRead(this.streamChatFunction, 'linkedin.md');
        props.privateBucket.grantRead(this.streamChatFunction, 'interests.md');
        props.privateBucket.grantRead(this.streamChatFunction, 'blog-embeddings.json');
        blogBucket.grantRead(this.streamChatFunction, 'posts/*');

        this.streamChatFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel'],
            resources: ['arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0'],
        }));

        // AI Notify: allow stream Lambda to publish MQTT events and read IoT endpoint from SSM.
        // The IAM policy is created by the ai-notify CDK stack — deploy that stack first.
        const aiNotifyPublishPolicyArn = ssm.StringParameter.valueForStringParameter(
            this, '/AiNotify/IotPublishPolicyArn',
        );
        this.streamChatFunction.role?.addManagedPolicy(
            iam.ManagedPolicy.fromManagedPolicyArn(
                this, 'AiNotifyPublishPolicy', aiNotifyPublishPolicyArn,
            ),
        );

        // Allow CloudFront (via OAC) to invoke the streaming function URL.
        // Both InvokeFunctionUrl AND InvokeFunction are required — without InvokeFunction,
        // Lambda's "Block public access" feature rejects the OAC-signed request with 403.
        this.streamChatFunction.addPermission('CloudFrontOACInvokeFunctionUrl', {
            principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
            action: 'lambda:InvokeFunctionUrl',
        });
        this.streamChatFunction.addPermission('CloudFrontOACInvokeFunction', {
            principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
            action: 'lambda:InvokeFunction',
        });

        this.streamFunctionUrl = this.streamChatFunction.addFunctionUrl({
            authType: lambda.FunctionUrlAuthType.AWS_IAM,
            invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
        });

        // Store the URL domain in SSM so CloudfrontStack can look it up at synth time
        // without creating a CloudFormation cross-stack export/import dependency.
        new ssm.StringParameter(this, 'StreamUrlDomainParam', {
            parameterName: '/nakom.is/stream-url-domain',
            description: 'Domain of the streaming Lambda Function URL (for CloudFront origin)',
            stringValue: cdk.Fn.select(2, cdk.Fn.split('/', this.streamFunctionUrl.url)),
        });

        // --- Blog Search Lambda ---
        // Exposes searchBlogJson() as a public HTTP endpoint for the blog site.
        const blogSearchLogGroup = new LogGroup(this, 'BlogSearchLambdaLogs', {
            logGroupName: '/nakom.is/lambda/blog-search',
            retention: RetentionDays.SIX_MONTHS,
        });

        this.blogSearchFunction = new NodejsFunction(this, 'BlogSearchFunction', {
            functionName: 'nakomis-blog-search',
            entry: 'lambda/blog-search/handler.ts',
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_20_X,
            memorySize: 256,
            timeout: Duration.seconds(30),
            logGroup: blogSearchLogGroup,
            environment: {
                PRIVATE_BUCKET:     props.privateBucket.bucketName,
                BLOG_CHUNKS_TABLE:  blogChunksTable.tableName,
            },
            bundling: { minify: true, sourceMap: true },
        });

        props.privateBucket.grantRead(this.blogSearchFunction, 'blog-embeddings.json');
        blogChunksTable.grant(this.blogSearchFunction, 'dynamodb:GetItem', 'dynamodb:BatchGetItem');
        this.blogSearchFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel'],
            resources: [
                'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0',
                // Cross-region inference profile for Haiku can route to any US region
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-20241022-v1:0',
                `arn:aws:bedrock:us-east-1:${this.account}:inference-profile/us.anthropic.claude-3-5-haiku-20241022-v1:0`,
            ],
        }));
    }
}
