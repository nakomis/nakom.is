import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import legacyNakomIs from '../route53/nakom.is.json';
import legacyNakomisCom from '../route53/nakomis.com.json';
import legacyNakomisCoUk from '../route53/nakomis.co.uk.json';
import { Construct } from 'constructs';


export interface Route53StackProps extends cdk.StackProps {

}

export class Route53Stack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: Route53StackProps) {
        super(scope, id, props);

        const nakomIsHostedZone = new route53.HostedZone(this, 'NakomIsHostedZone', {
            zoneName: 'nakom.is',
        });
        const nakomisComHostedZone = new route53.HostedZone(this, 'NakomisComHostedZone', {
            zoneName: 'nakomis.com',
        });
        const nakomisCoUkHostedZone = new route53.HostedZone(this, 'NakomisCoUkHostedZone', {
            zoneName: 'nakomis.co.uk',
        });

        [
            {
                hostedZone: nakomIsHostedZone,
                records: legacyNakomIs
            },
            {
                hostedZone: nakomisCoUkHostedZone,
                records: legacyNakomisCoUk
            },
            {
                hostedZone: nakomisComHostedZone,
                records: legacyNakomisCom
            }
        ].forEach(legacy => {
            legacy.records.ResourceRecordSets.forEach((rs) => {
                switch (rs.Type) {
                    case 'NS':
                    case 'SOA':
                        console.log("Skipping NS / SOA record import");
                        break;
                    case 'A':
                        if (rs.AliasTarget) {
                            // skip it, these are added as non-legacy
                        } else {
                            new route53.ARecord(this, `${legacy.hostedZone.zoneName}${rs.Type}${rs.Name}`, {
                                recordName: rs.Name,
                                zone: legacy.hostedZone,
                                target: route53.RecordTarget.fromValues(...rs.ResourceRecords.map((r) => r.Value)),
                                ttl: rs.TTL ? cdk.Duration.seconds(rs.TTL) : undefined
                            })
                        }
                        break;
                    case 'CNAME':
                        new route53.CnameRecord(this, `${legacy.hostedZone.zoneName}${rs.Type}${rs.Name}`, {
                            zone: legacy.hostedZone,
                            recordName: rs.Name,
                            domainName: rs.ResourceRecords![0].Value,
                            ttl: rs.TTL ? cdk.Duration.seconds(rs.TTL) : undefined
                        });
                        break;
                    case 'MX':
                        new route53.MxRecord(this, `${legacy.hostedZone.zoneName}${rs.Type}${rs.Name}`, {
                            zone: legacy.hostedZone,
                            recordName: rs.Name,
                            ttl: rs.TTL ? cdk.Duration.seconds(rs.TTL) : undefined,
                            values: rs.ResourceRecords!.map(rec => {
                                return { priority: +rec.Value.split(" ")[0], hostName: rec.Value.split(" ")[1] }
                            })
                        });
                        break;
                    case 'TXT':
                        new route53.TxtRecord(this, `${legacy.hostedZone.zoneName}${rs.Type}${rs.Name}`, {
                            zone: legacy.hostedZone,
                            recordName: rs.Name,
                            ttl: rs.TTL ? cdk.Duration.seconds(rs.TTL) : undefined,
                            values: rs.ResourceRecords!.map(rec => rec.Value.replace('"', ''))
                        });
                        break;
                    default:
                        console.error(`Unknown Route53 record type ${rs.Type} for ${rs.Name}`);
                }
            })
        });

    }
};