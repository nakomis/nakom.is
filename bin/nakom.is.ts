#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NakomIsStack } from '../lib/nakom.is-stack';
import { Route53Stack } from '../lib/route53-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { S3Stack } from '../lib/s3-stack';

const app = new cdk.App();

const s3Stack = new S3Stack(app, "S3Stack", {});
const lambdaStack = new LambdaStack(app, "LambdaStack", {});
const nakomIsStack = new NakomIsStack(app, 'NakomIsStack', {
    urlShortener: lambdaStack.getLambda(),
    bucket: s3Stack.s3bucket(),
    executionRole: s3Stack.executionRole()
});
const r53Stack = new Route53Stack(app, 'Route53Stack', {});
