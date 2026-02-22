import * as cdk from 'aws-cdk-lib';
import * as api from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface CloudfrontStackProps extends cdk.StackProps {
    gateway: api.RestApiBase,
    certificate: cm.Certificate,
    apiKeyString: string,
    enableStreamChat?: boolean,  // set to true once ChatStack has deployed the streaming Lambda
}

export class CloudfrontStack extends cdk.Stack {
    readonly distrubution: cloudfront.Distribution;

    constructor(scope: Construct, id: string, props?: CloudfrontStackProps) {
        super(scope, id, props);

        const apiOrigin = new origins.RestApiOrigin(props!.gateway, {
            customHeaders: {
                "x-api-key": props!.apiKeyString,
            }
        });

        // Redirect /social → / (canonical URL), rewrite / → /social for origin
        const socialRedirectFunction = new cloudfront.Function(this, 'SocialRedirectFunction', {
            functionName: 'nakomis-social-redirect',
            code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
    var uri = event.request.uri;
    if (uri === '/social' || uri === '/social/') {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: { location: { value: '/' } }
        };
    }
    if (uri === '/') {
        event.request.uri = '/social';
    }
    return event.request;
}
`),
            runtime: cloudfront.FunctionRuntime.JS_2_0,
        });

        const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {
            'chat': {
                origin: apiOrigin,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            },
        };

        // Streaming chat endpoint via Lambda Function URL (SSE support).
        // authType: AWS_IAM — CloudFront signs requests with OAC (SigV4).
        // The URL domain is read from SSM at synth time to avoid CloudFormation
        // cross-stack export/import coupling (which prevents independent stack updates).
        let cfnOac: cloudfront.CfnOriginAccessControl | undefined;
        if (props!.enableStreamChat) {
            // valueFromLookup makes a real SSM API call at cdk synth time and embeds
            // the concrete domain string in the template (no CloudFormation cross-stack ref).
            const fnUrlDomain = ssm.StringParameter.valueFromLookup(
                this, '/nakom.is/stream-url-domain'
            );

            cfnOac = new cloudfront.CfnOriginAccessControl(this, 'StreamOAC', {
                originAccessControlConfig: {
                    name: 'nakomis-stream-oac',
                    originAccessControlOriginType: 'lambda',
                    signingBehavior: 'always',
                    signingProtocol: 'sigv4',
                },
            });

            additionalBehaviors['chat-stream'] = {
                origin: new origins.HttpOrigin(fnUrlDomain, {
                    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
                }),
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                // CORS_CUSTOM_ORIGIN forwards Origin header for CORS but not Authorization,
                // avoiding conflicts with OAC's SigV4 signing.
                // Note: POST requests require the client to send x-amz-content-sha256 header
                // with the SHA-256 hash of the body (CloudFront passes this through to OAC
                // for SigV4 payload signing).
                originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_CUSTOM_ORIGIN,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            };
        }

        this.distrubution = new cloudfront.Distribution(this, 'NakomIsDistribution', {
            comment: 'URL Shortener',
            defaultBehavior: {
                origin: apiOrigin,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                functionAssociations: [{
                    function: socialRedirectFunction,
                    eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                }],
            },
            additionalBehaviors,
            domainNames: ['nakom.is', 'nakomis.com', 'nakomis.co.uk'],
            certificate: props!.certificate,
        });

        // Attach OAC to the Lambda Function URL origin.
        // CDK L2 doesn't yet support OAC for Lambda origins, so we use an escape hatch.
        // The stream origin is the second origin in the CloudFormation Origins array (index 1):
        //   index 0: API Gateway origin (shared by default and 'chat' behaviors)
        //   index 1: Lambda Function URL origin ('chat-stream' behavior)
        if (cfnOac) {
            const cfnDistrib = this.distrubution.node.defaultChild as cloudfront.CfnDistribution;
            cfnDistrib.addPropertyOverride(
                'DistributionConfig.Origins.1.OriginAccessControlId',
                cfnOac.attrId,
            );
        }
    }
};
