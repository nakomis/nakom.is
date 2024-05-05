import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface Route53StackProps extends cdk.StackProps {

}

export class Route53Stack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: Route53StackProps) {
        super(scope, id, props);
    }
};