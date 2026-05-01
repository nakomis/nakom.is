#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
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
import { DeployEnv } from '../lib/deploy-env';

const npmEnvironment = process.env.NPM_ENVIRONMENT;
if (!npmEnvironment) throw new Error('NPM_ENVIRONMENT is not set. Use NPM_ENVIRONMENT=sandbox|prod');
if (npmEnvironment !== 'sandbox' && npmEnvironment !== 'prod') {
    throw new Error(`NPM_ENVIRONMENT must be 'sandbox' or 'prod', got '${npmEnvironment}'`);
}
const deployEnv = npmEnvironment as DeployEnv;
const isProd = deployEnv === 'prod';

const accountId = isProd ? '637423226886' : '975050268859';
const londonEnv = { env: { account: accountId, region: 'eu-west-2' } };
const nvirginiaEnv = { env: { account: accountId, region: 'us-east-1' } };

const app = new cdk.App();

const s3Stack = new S3Stack(app, "S3Stack", { ...londonEnv, deployEnv });
const lambdaStack = new LambdaStack(app, "LambdaStack", { ...londonEnv, deployEnv });
const r53Stack = new Route53Stack(app, 'Route53Stack', {
    ...londonEnv,
    deployEnv,
    crossRegionReferences: true,
});
const sesStack = new SESStack(app, 'SESStack', {
    ...londonEnv,
    deployEnv,
    nakomIsZone: r53Stack.hostedZones.find(z => z.zoneName === r53Stack.nakomIsHostedZone.zoneName)!.zone,
});
const chatStack = new ChatStack(app, 'ChatStack', {
    ...londonEnv,
    deployEnv,
    sesIdentity: sesStack.emailIdentity,
    sesFromAddress: sesStack.fromAddress,
    privateBucket: s3Stack.privateBucket,
});
const apiGatewayStack = new ApiGatewayStack(app, 'ApiGatewayStack', {
    ...londonEnv,
    deployEnv,
    urlShortener: lambdaStack.getLambdaAlias(),
    bucket: s3Stack.s3bucket(),
    executionRole: s3Stack.executionRole(),
    chatFunction: chatStack.chatFunction,
    blogSearchFunction: chatStack.blogSearchFunction,
});
const certificateStack = new CertificateStack(app, 'CertificateStack', {
    ...nvirginiaEnv,
    deployEnv,
    crossRegionReferences: true,
    hostedZones: r53Stack.hostedZones,
});
const cloudfrontStack = new CloudfrontStack(app, 'CloudfrontStack', {
    ...londonEnv,
    deployEnv,
    gateway: apiGatewayStack.gateway,
    certificate: certificateStack.certificate,
    crossRegionReferences: true,
    apiKeyString: apiGatewayStack.apiKeyString,
    enableStreamChat: isProd,
});
const route53AdditionalStack = new Route53AdditionalStack(app, 'Route53AdditionalStack', {
    ...londonEnv,
    cloudfront: cloudfrontStack.distrubution,
    hostedZones: r53Stack.hostedZones.filter(z => !z.zoneName.includes('silverknowes')),
    crossRegionReferences: true,
});
const iamSecretStack = new IAMSecretStack(app, 'IAMSecretStack', {
    ...londonEnv,
    deployEnv,
    redirectsTable: lambdaStack.redirectTable,
});
const cvStack = new CvStack(app, 'CvStack', {
    ...londonEnv,
    deployEnv,
    privateBucket: s3Stack.privateBucket,
    publicBucket: s3Stack.bucket,
    distribution: cloudfrontStack.distrubution,
});
const linkedInStack = new LinkedInStack(app, 'LinkedInStack', {
    ...londonEnv,
    deployEnv,
    privateBucket: s3Stack.privateBucket,
});
// PostgresQueryStack omitted until NADM-3 (sandbox RDS) and NADM-4 (name-based lookups) are done.
// Re-enable and parameterise as part of NAKO-32.

cdk.Tags.of(app).add("MH-Project", "nakom.is");
const { version: infraVersion } = JSON.parse(fs.readFileSync('./version.json', 'utf-8'));
cdk.Tags.of(app).add("MH-Version", infraVersion);
