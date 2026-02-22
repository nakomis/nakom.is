#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ApiGatewayStack } from '../lib/apigateway-stack';
import { Route53Stack } from '../lib/route53-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { S3Stack } from '../lib/s3-stack';
import { CloudfrontStack } from '../lib/cloudfront-stack';
import { Route53AdditionalStack } from '../lib/route53-additional-stack';
import { CertificateStack } from '../lib/certificate-stack';
import { IAMSecretStack } from '../lib/iam-secret-stack';
import { SESStack } from '../lib/ses-stack';
import { ChatStack } from '../lib/chat-stack';
import { CvStack } from '../lib/cv-stack';
import { LinkedInStack } from '../lib/linkedin-stack';

const app = new cdk.App();

const londonEnv = { env: { account: '637423226886', region: 'eu-west-2' } };
const nvirginiaEnv = { env: { account: '637423226886', region: 'us-east-1' } };

const s3Stack = new S3Stack(app, "S3Stack", londonEnv);
const lambdaStack = new LambdaStack(app, "LambdaStack", londonEnv);
const r53Stack = new Route53Stack(app, 'Route53Stack', {
    ...londonEnv,
    crossRegionReferences: true
});
const sesStack = new SESStack(app, 'SESStack', {
    ...londonEnv,
    nakomIsZone: r53Stack.hostedZones.find(z => z.zoneName === 'nakom.is')!.zone,
});
const chatStack = new ChatStack(app, 'ChatStack', {
    ...londonEnv,
    sesIdentity: sesStack.emailIdentity,
    sesFromAddress: sesStack.fromAddress,
    privateBucket: s3Stack.privateBucket,
});
const apiGatewayStack = new ApiGatewayStack(app, 'ApiGatewayStack', {
    ...londonEnv,
    urlShortener: lambdaStack.getLambdaAlias(),
    bucket: s3Stack.s3bucket(),
    executionRole: s3Stack.executionRole(),
    chatFunction: chatStack.chatFunction,
});
const certificateStack = new CertificateStack(app, 'CertificateStack', {
    ...nvirginiaEnv,
    crossRegionReferences: true,
    hostedZones: r53Stack.hostedZones
});
const cloudfrontStack = new CloudfrontStack(app, 'CloudfrontStack', {
    ...londonEnv,
    gateway: apiGatewayStack.gateway,
    certificate: certificateStack.certificate,
    crossRegionReferences: true,
    apiKeyString: apiGatewayStack.apiKeyString,
    enableStreamChat: true,
});
const route53AdditionalStack = new Route53AdditionalStack(app, 'Route53AdditionalStack', {
    ...londonEnv,
    cloudfront: cloudfrontStack.distrubution,
    hostedZones: r53Stack.hostedZones,
    crossRegionReferences: true
});
const iamSecretStack = new IAMSecretStack(app, 'IAMSecretStack', {
    ...londonEnv,
    redirectsTable: lambdaStack.redirectTable
});
const cvStack = new CvStack(app, 'CvStack', {
    ...londonEnv,
    privateBucket: s3Stack.privateBucket,
    publicBucket: s3Stack.bucket,
    distribution: cloudfrontStack.distrubution,
});
const linkedInStack = new LinkedInStack(app, 'LinkedInStack', {
    ...londonEnv,
    privateBucket: s3Stack.privateBucket,
});

cdk.Tags.of(app).add("MH-Project", "nakom.is");
