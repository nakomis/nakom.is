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
import { DeployEnv, envSuffix, ssmPrefix, logPrefix, domain as envDomain } from './deploy-env';

export interface ChatStackProps extends cdk.StackProps {
    sesIdentity: ses.EmailIdentity;
    sesFromAddress: string;
    privateBucket: s3.Bucket;
    deployEnv: DeployEnv;
}

export class ChatStack extends cdk.Stack {
    readonly chatFunction: NodejsFunction;
    readonly streamChatFunction: NodejsFunction;
    readonly streamFunctionUrl: lambda.FunctionUrl;
    readonly blogSearchFunction: NodejsFunction;

    constructor(scope: Construct, id: string, props: ChatStackProps) {
        super(scope, id, props);

        const suffix = envSuffix(props.deployEnv);
        const ssmPfx = ssmPrefix(props.deployEnv);
        const logPfx = logPrefix(props.deployEnv);
        const d = envDomain(props.deployEnv);

        // Blog bucket (separate CDK app — reference by name, no cross-stack dependency)
        const blogBucket = s3.Bucket.fromBucketName(
            this, 'BlogBucket',
            `blog-nakom-is-${this.region}-${this.account}`
        );

        // Referenced, not created: these hold real secrets set out-of-band.
        // CDK must never own the value, or every deploy would reset it to a
        // placeholder and break chat (see NAKO-25). For a brand-new environment,
        // create these parameters manually before the first ChatStack deploy.
        const anthropicApiKeyParam = ssm.StringParameter.fromStringParameterName(
            this, 'AnthropicApiKey', `${ssmPfx}anthropic-api-key`
        );

        const martinEmailParam = ssm.StringParameter.fromStringParameterName(
            this, 'MartinEmailParam', `${ssmPfx}martin-email`
        );

        // DynamoDB Table for blog chunk metadata (text fetched after cosine search)
        const blogChunksTable = new dynamodb.TableV2(this, 'BlogChunks', {
            tableName:    `blog-chunks${suffix}`,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            billing:      dynamodb.Billing.onDemand(),
        });

        // DynamoDB Table for rate limiting
        const rateLimitTable = new dynamodb.TableV2(this, 'ChatRateLimits', {
            tableName: `chat-rate-limits${suffix}`,
            partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
            timeToLiveAttribute: 'expiry',
        });

        // DynamoDB Table for CV chat request logging
        const cvChatLogsTable = new dynamodb.TableV2(this, 'CvChatLogs', {
            tableName: `cv-chat-logs${suffix}`,
            partitionKey: { name: 'logType', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
            timeToLiveAttribute: 'ttl',
            billing: dynamodb.Billing.onDemand(),
        });

        // SSM cursor for analytics import - last timestamp successfully imported to RDS analytics DB
        new ssm.StringParameter(this, 'CvChatImportCursor', {
            parameterName: `${ssmPfx}analytics/CVCHAT/last-imported-timestamp`,
            description: 'Timestamp of last CV chat record imported to RDS analytics DB',
            stringValue: '1970-01-01T00:00:00.000Z',
        });

        // Log Group
        const logGroup = new LogGroup(this, 'ChatLambdaLogs', {
            logGroupName: `${logPfx}/lambda/chat`,
            retention: RetentionDays.SIX_MONTHS,
        });

        // Chat Lambda Function (esbuild bundled by CDK)
        this.chatFunction = new NodejsFunction(this, 'ChatFunction', {
            functionName: `nakomis-chat${suffix}`,
            entry: 'lambda/chat/handler.ts',
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_22_X,
            memorySize: 256,
            timeout: Duration.seconds(30),
            logGroup: logGroup,
            environment: {
                DAILY_RATE_LIMIT: '100',
                GITHUB_USER: 'nakomis',
                RATE_LIMIT_TABLE: rateLimitTable.tableName,
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
        blogChunksTable.grant(this.chatFunction, 'dynamodb:GetItem', 'dynamodb:BatchGetItem');

        // Grant SSM read access for the Anthropic API key and contact email
        anthropicApiKeyParam.grantRead(this.chatFunction);
        martinEmailParam.grantRead(this.chatFunction);

        // Grant SES send permission for the domain identity and any individually-verified addresses.
        // SES checks IAM against the most specific matching identity — if the recipient address is
        // individually verified, SES may check that identity's ARN rather than the domain ARN.
        this.chatFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ses:SendEmail'],
            resources: [
                props.sesIdentity.emailIdentityArn,
                `arn:${this.partition}:ses:${this.region}:${this.account}:identity/*@${d}`,
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
            logGroupName: `${logPfx}/lambda/chat-stream`,
            retention: RetentionDays.SIX_MONTHS,
        });

        this.streamChatFunction = new NodejsFunction(this, 'StreamChatFunction', {
            functionName: `nakomis-chat-stream${suffix}`,
            entry: 'lambda/chat/stream-handler.ts',
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_22_X,
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

        // AI Notify: prod-only — the ai-notify stack (and its SSM param) doesn't exist in sandbox.
        if (props.deployEnv === 'prod') {
            const aiNotifyPublishPolicyArn = ssm.StringParameter.valueForStringParameter(
                this, '/AiNotify/IotPublishPolicyArn',
            );
            this.streamChatFunction.role?.addManagedPolicy(
                iam.ManagedPolicy.fromManagedPolicyArn(
                    this, 'AiNotifyPublishPolicy', aiNotifyPublishPolicyArn,
                ),
            );
        }

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
            parameterName: `${ssmPfx}stream-url-domain`,
            description: 'Domain of the streaming Lambda Function URL (for CloudFront origin)',
            stringValue: cdk.Fn.select(2, cdk.Fn.split('/', this.streamFunctionUrl.url)),
        });

        // --- Blog Search Lambda ---
        // Exposes searchBlogJson() as a public HTTP endpoint for the blog site.
        const blogSearchLogGroup = new LogGroup(this, 'BlogSearchLambdaLogs', {
            logGroupName: `${logPfx}/lambda/blog-search`,
            retention: RetentionDays.SIX_MONTHS,
        });

        this.blogSearchFunction = new NodejsFunction(this, 'BlogSearchFunction', {
            functionName: `nakomis-blog-search${suffix}`,
            entry: 'lambda/blog-search/handler.ts',
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_22_X,
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
