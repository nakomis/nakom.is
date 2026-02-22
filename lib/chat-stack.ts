import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ses from 'aws-cdk-lib/aws-ses';
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
}

export class ChatStack extends cdk.Stack {
    readonly chatFunction: NodejsFunction;

    constructor(scope: Construct, id: string, props: ChatStackProps) {
        super(scope, id, props);

        const secrets = loadSecrets();

        // SSM Parameter for Anthropic API key
        const anthropicApiKeyParam = new ssm.StringParameter(this, 'AnthropicApiKey', {
            parameterName: '/nakom.is/anthropic-api-key',
            description: 'Anthropic API key for nakom.is chat feature',
            stringValue: secrets.anthropicApiKey,
        });

        // DynamoDB Table for rate limiting
        const rateLimitTable = new dynamodb.TableV2(this, 'ChatRateLimits', {
            tableName: 'chat-rate-limits',
            partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
            timeToLiveAttribute: 'expiry',
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
            },
            bundling: {
                minify: true,
                sourceMap: true,
            },
        });

        // Grant DynamoDB access
        rateLimitTable.grant(this.chatFunction, 'dynamodb:UpdateItem');

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
    }
}
