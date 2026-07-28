import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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
        this.redirectsFunction = new lambda.Function(this, 'RedirectsFunction', {
            functionName: `urlShortener${suffix}`,
            runtime: lambda.Runtime.PYTHON_3_12,
            // Scope the asset to just this function's own directory. It used to
            // bundle the whole `lambda/` tree — which meant zipping every sibling
            // lambda's node_modules into this 2 KB Python function, and eventually
            // blew past Lambda's 250 MiB unzipped limit as those deps grew.
            code: lambda.Code.fromAsset('lambda/urlshortener'),
            handler: 'urlshortener.lambda_handler',
            logGroup: logGroup,
            timeout: Duration.seconds(10),
            environment: {
                // The table name is environment-suffixed, so the function must be
                // told which one to use. Hardcoding 'redirects' in the handler meant
                // sandbox looked up the prod table name, which its role has no grant
                // for, so every /<path> lookup returned 502.
                REDIRECTS_TABLE: this.redirectTable.tableName,
            },
        });

        this.redirectsFunctionAlias = new lambda.Alias(this, 'RedirectsFunctionAlias', {
            aliasName: 'live',
            version: this.redirectsFunction.currentVersion,
            provisionedConcurrentExecutions: 1,
        });

        this.redirectTable.grant(this.redirectsFunction, "dynamodb:GetItem", "dynamodb:PutItem");
    }

    getLambda(): lambda.Function {
        return this.redirectsFunction;
    }

    getLambdaAlias(): lambda.IFunction {
        return this.redirectsFunctionAlias;
    }
};
