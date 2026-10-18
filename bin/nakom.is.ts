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
import { GithubCiStack } from '../lib/github-ci-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

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

const s3Stack = new S3Stack(app, "S3Stack", {
    ...londonEnv,
    description: 'Public files bucket, private source-documents bucket and the role API Gateway uses to read S3 (plus, in prod, the reserved nakom.is bucket name).',
    deployEnv,
});
const lambdaStack = new LambdaStack(app, "LambdaStack", {
    ...londonEnv,
    description: 'URL shortener Lambda with its redirects and ticket-projects DynamoDB tables, and the Roles Anywhere roles the Plane MCP uses to sync ticket projects.',
    deployEnv,
});
const r53Stack = new Route53Stack(app, 'Route53Stack', {
    ...londonEnv,
    description: 'Route53 hosted zones for nakom.is, nakomis.com and nakomis.co.uk with their legacy records (prod), or lookups of the sandbox.nakom.is and sandbox.nakomis.com zones (sandbox).',
    deployEnv,
    crossRegionReferences: true,
});
const sesStack = new SESStack(app, 'SESStack', {
    ...londonEnv,
    description: 'SES domain identity for nakom.is (sandbox.nakom.is in sandbox) as the chat@ sender, with DKIM records and a custom MAIL FROM domain.',
    deployEnv,
    nakomIsZone: r53Stack.hostedZones.find(z => z.zoneName === r53Stack.nakomIsHostedZone.zoneName)!.zone,
});
const chatStack = new ChatStack(app, 'ChatStack', {
    ...londonEnv,
    description: 'Chat, streaming chat and blog search Lambdas with their rate-limit, CV chat log and blog-chunks DynamoDB tables.',
    deployEnv,
    sesIdentity: sesStack.emailIdentity,
    sesFromAddress: sesStack.fromAddress,
    privateBucket: s3Stack.privateBucket,
});
const apiGatewayStack = new ApiGatewayStack(app, 'ApiGatewayStack', {
    ...londonEnv,
    description: 'REST API fronting the URL shortener, chat, blog search and S3 files, with its API keys and usage plans.',
    deployEnv,
    urlShortener: lambdaStack.getLambdaAlias(),
    bucket: s3Stack.s3bucket(),
    executionRole: s3Stack.executionRole(),
    chatFunction: chatStack.chatFunction,
    blogSearchFunction: chatStack.blogSearchFunction,
});
const certificateStack = new CertificateStack(app, 'CertificateStack', {
    ...nvirginiaEnv,
    description: 'ACM certificate in us-east-1 for the CloudFront distribution, DNS-validated in the Route53 hosted zones.',
    deployEnv,
    crossRegionReferences: true,
    hostedZones: r53Stack.hostedZones,
});
const cloudfrontStack = new CloudfrontStack(app, 'CloudfrontStack', {
    ...londonEnv,
    description: 'CloudFront distribution in front of API Gateway (and, in prod, the streaming chat Lambda), with redirect functions and the cv subdomain alias record.',
    deployEnv,
    gateway: apiGatewayStack.gateway,
    certificate: certificateStack.certificate,
    crossRegionReferences: true,
    apiKeyString: apiGatewayStack.apiKeyString,
    enableStreamChat: isProd,
});
const route53AdditionalStack = new Route53AdditionalStack(app, 'Route53AdditionalStack', {
    ...londonEnv,
    description: 'A and AAAA alias records pointing each nakom.is-family zone apex at the CloudFront distribution.',
    cloudfront: cloudfrontStack.distrubution,
    hostedZones: r53Stack.hostedZones.filter(z => !z.zoneName.includes('silverknowes')),
    crossRegionReferences: true,
});
const iamSecretStack = new IAMSecretStack(app, 'IAMSecretStack', {
    ...londonEnv,
    description: 'IAM user for the nis shortcut CLI, with its access key stored in SSM and access to the redirects table.',
    deployEnv,
    redirectsTable: lambdaStack.redirectTable,
});
const cvStack = new CvStack(app, 'CvStack', {
    ...londonEnv,
    description: 'Lambda that renders cv.md from the private bucket to a PDF in the public bucket and invalidates CloudFront.',
    deployEnv,
    privateBucket: s3Stack.privateBucket,
    publicBucket: s3Stack.bucket,
    distribution: cloudfrontStack.distrubution,
});
const linkedInStack = new LinkedInStack(app, 'LinkedInStack', {
    ...londonEnv,
    description: 'Lambda that turns a LinkedIn CSV export in the private bucket into linkedin.md.',
    deployEnv,
    privateBucket: s3Stack.privateBucket,
});
// PostgresQueryStack omitted until NADM-3 (sandbox RDS) and NADM-4 (name-based lookups) are done.
// Re-enable and parameterise as part of NAKO-32.

new GithubCiStack(app, 'GithubCiStack', {
    ...londonEnv,
    description: 'IAM role assumed by nakom.is GitHub Actions via OIDC to run CDK deploys.',
    deployEnv,
    githubOidcProviderArn: `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`,
});

// Last: addresses everything by name, so it has no cross-stack references.
new MonitoringStack(app, 'MonitoringStack', {
    ...londonEnv,
    description: 'CloudWatch health dashboard: API Gateway requests and error rates, Lambda duration and errors, CloudFront cache hit rate.',
    deployEnv,
});

cdk.Tags.of(app).add("MH-Project", "nakom.is");
const { version: infraVersion } = JSON.parse(fs.readFileSync('./version.json', 'utf-8'));
cdk.Tags.of(app).add("MH-Version", infraVersion);
