import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';

// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class NakomIsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    // example resource
    // const queue = new sqs.Queue(this, 'NakomIsQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
    const redirectTable = new TableV2(this, 'redirects', {
      tableName: 'redirects',
      partitionKey: { name: 'shortPath', type: AttributeType.STRING },
    });

    const redirectsFunction = new lambda.Function(this, 'RedirectsFunction', {
      functionName: 'urlShortener',
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'urlshortener.lambda_handler'
    });

    redirectTable.grantReadWriteData(redirectsFunction);

  }
}
