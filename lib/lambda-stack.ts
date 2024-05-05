import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface LambdaStackProps extends cdk.StackProps {
  
}

export class LambdaStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: LambdaStackProps) {
      super(scope, id, props);

    }
};