import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MonitoringStack } from '../lib/monitoring-stack';
import { DeployEnv } from '../lib/deploy-env';

function synth(deployEnv: DeployEnv): { template: Template, body: string } {
    const app = new cdk.App();
    const stack = new MonitoringStack(app, 'TestMonitoringStack', {
        env: { account: '123456789012', region: 'eu-west-2' },
        deployEnv,
    });
    const template = Template.fromStack(stack);
    const [dashboard] = Object.values(template.findResources('AWS::CloudWatch::Dashboard'));
    const bodyParts = (dashboard as any).Properties.DashboardBody['Fn::Join'][1] as any[];
    return { template, body: bodyParts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join('') };
}

describe('MonitoringStack dashboard (NAKIS-21)', () => {
    it.each([
        ['prod', 'nakomis-health', ''],
        ['sandbox', 'nakomis-health-sandbox', '-sandbox'],
    ] as const)('%s: names the dashboard and graphs the requested Lambdas', (deployEnv, name, suffix) => {
        const { template, body } = synth(deployEnv);
        template.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: name });
        for (const fn of ['nakomis-chat', 'nakomis-chat-stream', 'nakomis-blog-search', 'urlShortener', 'nakomis-cv']) {
            expect(body).toContain(`"FunctionName","${fn}${suffix}"`);
        }
        expect(body).not.toContain('nakomis-linkedin');
        expect(body).not.toContain('nakomis-postgres-query');
    });

    it('graphs API Gateway requests and error rates, and CloudFront cache hit rate in us-east-1', () => {
        const { body } = synth('prod');
        for (const metric of ['"Count"', '"4XXError"', '"5XXError"']) {
            expect(body).toContain(`"AWS/ApiGateway",${metric},"ApiName","nakom.is"`);
        }
        expect(body).toContain('MetricName=\\"CacheHitRate\\"');
        expect(body).toContain('"region":"us-east-1"');
    });

    it('has no cross-stack references', () => {
        const { template } = synth('prod');
        expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
    });
});
