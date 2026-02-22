import * as cdk from 'aws-cdk-lib';
import * as api from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface CloudfrontStackProps extends cdk.StackProps {
    gateway: api.RestApiBase,
    certificate: cm.Certificate,
    apiKeyString: string
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
            additionalBehaviors: {
                'chat': {
                    origin: apiOrigin,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                },
            },
            domainNames: ['nakom.is', 'nakomis.com', 'nakomis.co.uk'],
            certificate: props!.certificate
        });
    }
};
