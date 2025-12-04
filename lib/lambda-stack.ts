import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface LambdaStackProps extends cdk.StackProps {

}

export class LambdaStack extends cdk.Stack {
    readonly redirectsFunction: lambda.Function;
    readonly redirectTable: dynamodb.TableV2;

    constructor(scope: Construct, id: string, props?: LambdaStackProps) {
        super(scope, id, props);

        // DynamoDB Table
        this.redirectTable = new dynamodb.TableV2(this, 'redirects', {
            tableName: 'redirects',
            partitionKey: { name: 'shortPath', type: dynamodb.AttributeType.STRING },
        });

        // Create a CloudWatch Log Group for storing access logs
        const logGroup = new LogGroup(this, 'LambdaAccessLogs', {
            logGroupName: '/nakom.is/lambda/urlShortener',
            retention: RetentionDays.SIX_MONTHS,
        });

        // Lambda Function
        this.redirectsFunction = new lambda.Function(this, 'RedirectsFunction', {
            functionName: 'urlShortener',
            runtime: lambda.Runtime.PYTHON_3_12,
            code: lambda.Code.fromAsset('lambda'),
            handler: 'urlshortener.lambda_handler',
            logGroup: logGroup
        });

        this.redirectTable.grant(this.redirectsFunction, "dynamodb:GetItem", "dynamodb:PutItem");
    }

    getLambda(): lambda.Function {
        return this.redirectsFunction;
    }
};