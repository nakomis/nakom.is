#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NakomIsStack } from '../lib/nakom.is-stack';
import { Route53Stack } from '../lib/route53-stack';
import { LambdaStack } from '../lib/lambda-stack';

const app = new cdk.App();

const lambdaStack = new LambdaStack(app, "LambdaStack", {});

const nakomIsStack = new NakomIsStack(app, 'NakomIsStack', {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: 'nakom-is', region: 'eu-west-2' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */

});

const r53Stack = new Route53Stack(app, 'Route53Stack', {});
