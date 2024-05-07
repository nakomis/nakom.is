import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { R53Zone } from './route53-stack';

export interface CertificateValidationStackProps extends cdk.StackProps {
    hostedZones: R53Zone[]
}

export class CertificateValidationStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: CertificateValidationStackProps) {
        super(scope, id, props);

        new route53.CnameRecord(this, 'NakomisCoUkDNSValidation', {
            zone: props.hostedZones.find(z => 'nakomis.co.uk' == z.zoneName)!.zone as route53.HostedZone,
            recordName: '_6268b0b5b803c054d13338452449489f.nakomis.co.uk.',
            domainName: '_4a10a1eef76bc0633ba480d76d45e673.mhbtsbpdnt.acm-validations.aws.'
        });

        new route53.CnameRecord(this, 'NakomisComDNSValidation', {
            zone: props.hostedZones.find(z => 'nakomis.com' == z.zoneName)!.zone as route53.HostedZone,
            recordName: '_922722e62e8b09e38ef1a47a4d37e00e.nakomis.com.',
            domainName: '_b20903bcc12790e0d103f18c6ade05e3.mhbtsbpdnt.acm-validations.aws.'
        });
        
    }
};