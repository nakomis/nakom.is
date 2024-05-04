import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class NakomIsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    // example resource
    // const queue = new sqs.Queue(this, 'NakomIsQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
    const table = new TableV2(this, 'redirects', {
      tableName: 'redirects',
      partitionKey: { name: 'shortPath', type: AttributeType.STRING },
    });
  }
}
