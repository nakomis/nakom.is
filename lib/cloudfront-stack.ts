import * as cdk from 'aws-cdk-lib';
import * as api from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface CloudfrontStackProps extends cdk.StackProps {
    gateway: api.RestApiBase,
    certificate?: cm.Certificate
}

export class CloudfrontStack extends cdk.Stack {
    readonly distrubution: cloudfront.Distribution;

    constructor(scope: Construct, id: string, props?: CloudfrontStackProps) {
        super(scope, id, props);

        this.distrubution = new cloudfront.Distribution(this, 'NakomIsDistribution', {
            defaultBehavior: {
                origin: new origins.RestApiOrigin(props!.gateway),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
            },
            defaultRootObject: '/google',
            domainNames: ['nakom.is', 'nakomis.com', 'nakomis.co.uk'],
            certificate: cm.Certificate.fromCertificateArn(this, '3DomainCertificate', 'arn:aws:acm:us-east-1:637423226886:certificate/4a16faae-2132-4b09-952b-119fbb70f861')
        });
    }
};