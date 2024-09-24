import * as cdk from 'aws-cdk-lib';
import * as api from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface CloudfrontStackProps extends cdk.StackProps {
    gateway: api.RestApiBase,
    certificate: cm.Certificate,
    secret: sm.Secret
}

export class CloudfrontStack extends cdk.Stack {
    readonly distrubution: cloudfront.Distribution;

    constructor(scope: Construct, id: string, props?: CloudfrontStackProps) {
        super(scope, id, props);

        this.distrubution = new cloudfront.Distribution(this, 'NakomIsDistribution', {
            defaultBehavior: {
                origin: new origins.RestApiOrigin(props!.gateway, {
                    customHeaders: {
                        "x-api-key": props!.secret.secretValueFromJson('apiKey').unsafeUnwrap(),
                    }
                }),
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
            },
            defaultRootObject: '/google',
            domainNames: ['nakom.is', 'nakomis.com', 'nakomis.co.uk'],
            certificate: props!.certificate
        });
    }
};