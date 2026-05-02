import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { DeployEnv, domain as envDomain } from './deploy-env';

export interface SESStackProps extends cdk.StackProps {
    nakomIsZone: route53.IHostedZone;
    deployEnv: DeployEnv;
}

export class SESStack extends cdk.Stack {
    readonly emailIdentity: ses.EmailIdentity;
    readonly fromAddress: string;

    constructor(scope: Construct, id: string, props: SESStackProps) {
        super(scope, id, props);

        const d = envDomain(props.deployEnv);
        this.fromAddress = `chat@${d}`;

        // Reference the existing hosted zone as a public hosted zone so CDK can
        // automatically write the DKIM CNAME records into it. These records are
        // owned by this stack (SESStack), not by Route53Stack.
        const publicZone = route53.PublicHostedZone.fromHostedZoneAttributes(
            this, 'NakomIsPublicZoneRef',
            {
                hostedZoneId: props.nakomIsZone.hostedZoneId,
                zoneName: props.nakomIsZone.zoneName,
            }
        );

        this.emailIdentity = new ses.EmailIdentity(this, 'NakomIsEmailIdentity', {
            identity: ses.Identity.publicHostedZone(publicZone),
            mailFromDomain: `mail.${d}`,
        });
    }
}
