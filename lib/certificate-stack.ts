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

        var nakomisCoUkZone = route53.HostedZone.fromHostedZoneId(this, "NakomisCoUkZone", "Z0375957KMNCCT5ARZ9B");
        var nakomisComZone = route53.HostedZone.fromHostedZoneId(this, "NakomisComZone", "Z019437529YGFB53BDUGR");

        new route53.CnameRecord(this, 'NakomisCoUkDNSValidation', {
            zone: nakomisCoUkZone,
            recordName: '_6268b0b5b803c054d13338452449489f.nakomis.co.uk.',
            domainName: '_4a10a1eef76bc0633ba480d76d45e673.mhbtsbpdnt.acm-validations.aws.'
        });

        new route53.CnameRecord(this, 'NakomisComDNSValidation', {
            zone: nakomisComZone,
            recordName: '_922722e62e8b09e38ef1a47a4d37e00e.nakomis.com.',
            domainName: '_b20903bcc12790e0d103f18c6ade05e3.mhbtsbpdnt.acm-validations.aws.'
        });
        
    }
};