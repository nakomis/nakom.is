import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { R53Zone } from './route53-stack';

export interface CertificateStackProps extends cdk.StackProps {
    hostedZones: R53Zone[]
}

export class CertificateStack extends cdk.Stack {
    readonly certificate: cm.Certificate;
    
    constructor(scope: Construct, id: string, props: CertificateStackProps) {
        super(scope, id, props);

        const initialValue = {};
        var dnsMultiZone: {[domainName: string]: route53.IHostedZone} = props.hostedZones.reduce((partial, hostedZone) => {
            return {
                ...partial,
                [hostedZone.zoneName]: hostedZone.zone,
            };
        }, initialValue);

        this.certificate = new cm.Certificate(this, "NakomIsCert", {
            domainName: 'nakom.is',
            subjectAlternativeNames: ['nakomis.com', 'nakomis.co.uk'],
            validation: cm.CertificateValidation.fromDnsMultiZone(dnsMultiZone)
        });
    }
};