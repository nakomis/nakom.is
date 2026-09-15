import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { DeployEnv, envSuffix, logPrefix } from './deploy-env';

export interface LambdaStackProps extends cdk.StackProps {
    deployEnv: DeployEnv;
}

export class LambdaStack extends cdk.Stack {
    readonly redirectsFunction: lambda.Function;
    readonly redirectsFunctionAlias: lambda.Alias;
    readonly redirectTable: dynamodb.TableV2;

    constructor(scope: Construct, id: string, props: LambdaStackProps) {
        super(scope, id, props);

        const suffix = envSuffix(props.deployEnv);
        const logPfx = logPrefix(props.deployEnv);

        // DynamoDB Table
        this.redirectTable = new dynamodb.TableV2(this, 'redirects', {
            tableName: `redirects${suffix}`,
            partitionKey: { name: 'shortPath', type: dynamodb.AttributeType.STRING },
        });

        // Create a CloudWatch Log Group for storing access logs
        const logGroup = new LogGroup(this, 'LambdaAccessLogs', {
            logGroupName: `${logPfx}/lambda/urlShortener`,
            retention: RetentionDays.SIX_MONTHS,
        });

        // Lambda Function
        // Lambda Function (esbuild bundled by CDK). NodejsFunction bundles only
        // this handler's own entry point, so the asset stays small.
        this.redirectsFunction = new NodejsFunction(this, 'RedirectsFunction', {
            functionName: `urlShortener${suffix}`,
            entry: 'lambda/shortener/handler.ts',
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_24_X,
            memorySize: 256,
            logGroup: logGroup,
            timeout: Duration.seconds(10),
            environment: {
                // Table names are environment-suffixed, so the function must be told
                // which ones to use rather than hardcoding the production names.
                REDIRECTS_TABLE: this.redirectTable.tableName,
            },
            bundling: {
                minify: true,
                sourceMap: true,
            },
        });

        this.redirectsFunctionAlias = new lambda.Alias(this, 'RedirectsFunctionAlias', {
            aliasName: 'live',
            version: this.redirectsFunction.currentVersion,
            provisionedConcurrentExecutions: 1,
        });

        this.redirectTable.grant(this.redirectsFunction, "dynamodb:UpdateItem");
    }

    getLambda(): lambda.Function {
        return this.redirectsFunction;
    }

    getLambdaAlias(): lambda.IFunction {
        return this.redirectsFunctionAlias;
    }
};
