import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface CvStackProps extends cdk.StackProps {
    privateBucket: s3.Bucket;
    publicBucket: s3.Bucket;
    distribution: cloudfront.Distribution;
}

export class CvStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: CvStackProps) {
        super(scope, id, props);

        const logGroup = new LogGroup(this, 'CvLambdaLogs', {
            logGroupName: '/nakom.is/lambda/cv',
            retention: RetentionDays.SIX_MONTHS,
        });

        // CV generation Lambda: reads cv.md from private bucket, renders PDF via Chromium, writes to public bucket
        const cvFunction = new NodejsFunction(this, 'CvFunction', {
            functionName: 'nakomis-cv',
            entry: 'lambda/cv/handler.ts',
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_20_X,
            memorySize: 1024,
            timeout: Duration.seconds(120),
            logGroup,
            depsLockFilePath: 'lambda/cv/package-lock.json',
            environment: {
                PRIVATE_BUCKET: props.privateBucket.bucketName,
                PUBLIC_BUCKET: props.publicBucket.bucketName,
                CF_DISTRIBUTION_ID: props.distribution.distributionId,
            },
            bundling: {
                minify: true,
                // @sparticuz/chromium-min, puppeteer-core, and marked must not be
                // tree-shaken by esbuild; install them as real node_modules instead
                nodeModules: ['@sparticuz/chromium-min', 'puppeteer-core', 'marked'],
            },
        });

        // Trigger via EventBridge (avoids cross-stack S3 notification cycle).
        // The private bucket must have eventBridgeEnabled: true in S3Stack.
        new events.Rule(this, 'CvMdUploadRule', {
            eventPattern: {
                source: ['aws.s3'],
                detailType: ['Object Created'],
                detail: {
                    bucket: { name: [props.privateBucket.bucketName] },
                    object: { key: [{ prefix: 'cv.md' }] },
                },
            },
            targets: [new targets.LambdaFunction(cvFunction)],
        });

        // IAM: read cv.md from private bucket
        props.privateBucket.grantRead(cvFunction, 'cv.md');

        // IAM: write cv.pdf to public bucket
        props.publicBucket.grantPut(cvFunction, 'cv.pdf');

        // IAM: CloudFront invalidation
        cvFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['cloudfront:CreateInvalidation'],
            resources: [`arn:${this.partition}:cloudfront::${this.account}:distribution/${props.distribution.distributionId}`],
        }));
    }
}
