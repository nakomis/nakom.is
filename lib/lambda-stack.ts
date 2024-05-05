import * as cdk from 'aws-cdk-lib';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface LambdaStackProps extends cdk.StackProps {

}

export class LambdaStack extends cdk.Stack {
    readonly redirectsFunction: lambda.Function;

    constructor(scope: Construct, id: string, props?: LambdaStackProps) {
        super(scope, id, props);

        // DynamoDB Table
        const redirectTable = new TableV2(this, 'redirects', {
            tableName: 'redirects',
            partitionKey: { name: 'shortPath', type: AttributeType.STRING },
        });

        // Lambda Function
        this.redirectsFunction = new lambda.Function(this, 'RedirectsFunction', {
            functionName: 'urlShortener',
            runtime: lambda.Runtime.PYTHON_3_9,
            code: lambda.Code.fromAsset('lambda'),
            handler: 'urlshortener.lambda_handler'
        });

        redirectTable.grant(this.redirectsFunction, "dynamodb:GetItem", "dynamodb:PutItem");
    }

    getLambda(): lambda.Function {
        return this.redirectsFunction;
    }
};