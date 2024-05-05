import * as cdk from 'aws-cdk-lib';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface CertificateStackProps extends cdk.StackProps {
    hostedZones: route53.HostedZone[]
}

export class CertificateStack extends cdk.Stack {
    readonly certificate: cm.Certificate;

    constructor(scope: Construct, id: string, props?: CertificateStackProps) {
        super(scope, id, props);
        // Create the certificate
        this.certificate = new cm.DnsValidatedCertificate(this, "NewCert", {
            hostedZone: props!.hostedZones[0],
            domainName: props!.hostedZones[0].zoneName,
            region: 'us-east-1'
        });
    }
};