import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { R53Zone } from './route53-stack';
import { DeployEnv, domain as envDomain } from './deploy-env';

export interface CertificateStackProps extends cdk.StackProps {
    hostedZones: R53Zone[];
    deployEnv: DeployEnv;
}

export class CertificateStack extends cdk.Stack {
    readonly certificate: cm.Certificate;

    constructor(scope: Construct, id: string, props: CertificateStackProps) {
        super(scope, id, props);

        const d = envDomain(props.deployEnv);
        const isProd = props.deployEnv === 'prod';

        const dnsMultiZone: {[domainName: string]: route53.IHostedZone} = props.hostedZones.reduce(
            (partial, hostedZone) => ({ ...partial, [hostedZone.zoneName]: hostedZone.zone }),
            {} as {[domainName: string]: route53.IHostedZone},
        );

        if (isProd) {
            // cv.nakomis.com is validated in the nakomis.com zone
            const nakomisComZone = props.hostedZones.find(z => z.zoneName === 'nakomis.com')!.zone;
            dnsMultiZone['cv.nakomis.com'] = nakomisComZone;
        } else {
            // cv.sandbox.nakomis.com is validated in the sandbox.nakomis.com zone
            const sandboxNakomisComZone = props.hostedZones.find(z => z.zoneName === 'sandbox.nakomis.com')!.zone;
            dnsMultiZone['cv.sandbox.nakomis.com'] = sandboxNakomisComZone;
        }

        const cvDomain = isProd ? 'cv.nakomis.com' : 'cv.sandbox.nakomis.com';

        this.certificate = new cm.Certificate(this, "NakomIsCert", {
            domainName: d,
            subjectAlternativeNames: isProd
                ? ['nakomis.com', 'nakomis.co.uk', 'cv.nakomis.com']
                : ['cv.sandbox.nakomis.com'],
            validation: cm.CertificateValidation.fromDnsMultiZone(dnsMultiZone)
        });
    }
};
