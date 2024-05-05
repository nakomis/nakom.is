import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

export interface Route53AdditionalStackProps extends cdk.StackProps {
    cloudfront: cloudfront.Distribution,
    hostedZones: route53.HostedZone[]
}

export class Route53AdditionalStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: Route53AdditionalStackProps) {
        super(scope, id, props);

        props?.hostedZones.forEach(zone => {
            // Create the A Alias record, pointing to the CDN
            new route53.ARecord(this, `${zone.zoneName}AApiGateway`, {
                recordName: zone.zoneName,
                zone: zone,
                target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(props!.cloudfront))
            });
        });
    }
};