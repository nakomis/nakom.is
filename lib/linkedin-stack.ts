import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface LinkedInStackProps extends cdk.StackProps {
    privateBucket: s3.Bucket;
}

export class LinkedInStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: LinkedInStackProps) {
        super(scope, id, props);

        const logGroup = new LogGroup(this, 'LinkedInLambdaLogs', {
            logGroupName: '/nakom.is/lambda/linkedin',
            retention: RetentionDays.SIX_MONTHS,
        });

        // LinkedIn parser Lambda: reads CSVs from linkedin-export/ prefix, generates linkedin.md
        const linkedInFunction = new NodejsFunction(this, 'LinkedInFunction', {
            functionName: 'nakomis-linkedin',
            entry: 'lambda/linkedin/handler.ts',
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_20_X,
            memorySize: 256,
            timeout: Duration.seconds(30),
            logGroup,
            depsLockFilePath: 'lambda/linkedin/package-lock.json',
            environment: {
                PRIVATE_BUCKET: props.privateBucket.bucketName,
            },
            bundling: {
                minify: true,
                nodeModules: ['csv-parse'],
            },
        });

        // Trigger via EventBridge (avoids cross-stack S3 notification cycle).
        // The private bucket must have eventBridgeEnabled: true in S3Stack.
        new events.Rule(this, 'LinkedInUploadRule', {
            eventPattern: {
                source: ['aws.s3'],
                detailType: ['Object Created'],
                detail: {
                    bucket: { name: [props.privateBucket.bucketName] },
                    object: { key: [{ prefix: 'linkedin-export/' }] },
                },
            },
            targets: [new targets.LambdaFunction(linkedInFunction)],
        });

        // IAM: read CSVs from linkedin-export/
        linkedInFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject'],
            resources: [`${props.privateBucket.bucketArn}/linkedin-export/*`],
        }));

        // IAM: list bucket to check which CSVs are present
        linkedInFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:ListBucket'],
            resources: [props.privateBucket.bucketArn],
            conditions: {
                StringLike: {
                    's3:prefix': ['linkedin-export/*'],
                },
            },
        }));

        // IAM: write linkedin.md to private bucket
        props.privateBucket.grantPut(linkedInFunction, 'linkedin.md');
    }
}
