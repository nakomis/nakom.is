import * as cdk from 'aws-cdk-lib';
import * as api from 'aws-cdk-lib/aws-apigateway';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CloudfrontStack } from '../lib/cloudfront-stack';
import { DeployEnv } from '../lib/deploy-env';

const account = '123456789012';

function synth(deployEnv: DeployEnv, enableStreamChat = false): Template {
    const app = new cdk.App();
    const certStack = new cdk.Stack(app, 'TestCertStack', {
        env: { account, region: 'us-east-1' },
        crossRegionReferences: true,
    });
    const certificate = new cm.Certificate(certStack, 'Cert', { domainName: 'nakom.is' });
    const apiStack = new cdk.Stack(app, 'TestApiStack', { env: { account, region: 'eu-west-2' } });
    const gateway = new api.RestApi(apiStack, 'Api');
    gateway.root.addMethod('GET');
    const stack = new CloudfrontStack(app, 'TestCloudfrontStack', {
        env: { account, region: 'eu-west-2' },
        crossRegionReferences: true,
        deployEnv,
        gateway,
        certificate,
        apiKeyString: 'test-key',
        enableStreamChat,
    });
    return Template.fromStack(stack);
}

function behaviours(template: Template): any[] {
    const [distribution] = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    return (distribution as any).Properties.DistributionConfig.CacheBehaviors ?? [];
}

// Files that must be served from nakomis.com itself rather than redirected to the blog (NAKIS-10).
describe('CloudFront redirect bypass behaviours', () => {
    const bypassPaths = ['ads.txt', 'robots.txt', 'favicon.ico'];

    describe('prod', () => {
        const template = synth('prod');

        it.each(bypassPaths)('serves %s from the API Gateway origin without the redirect function', (path) => {
            const behaviour = behaviours(template).find(b => b.PathPattern === path);
            expect(behaviour).toBeDefined();
            expect(behaviour.FunctionAssociations).toBeUndefined();
            expect(behaviour.AllowedMethods).toEqual(['GET', 'HEAD']);
            expect(behaviour.ViewerProtocolPolicy).toBe('redirect-to-https');
            // Managed CachingDisabled policy, as used by the original ads.txt behaviour
            expect(behaviour.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
            expect(behaviour.TargetOriginId).toBe('NakomIsApiOrigin');
        });

        it('keeps the redirect function on the default behaviour', () => {
            template.hasResourceProperties('AWS::CloudFront::Distribution', {
                DistributionConfig: Match.objectLike({
                    DefaultCacheBehavior: Match.objectLike({
                        FunctionAssociations: Match.arrayWith([
                            Match.objectLike({ EventType: 'viewer-request' }),
                        ]),
                    }),
                }),
            });
        });

        it('describes what the distribution serves', () => {
            template.hasResourceProperties('AWS::CloudFront::Distribution', {
                DistributionConfig: Match.objectLike({
                    Comment: Match.stringLikeRegexp('shortener.*CV.*chat.*nakomis\\.com to blog'),
                }),
            });
        });

        it('keeps the stream origin at index 1 for the OAC escape hatch', () => {
            const streamTemplate = synth('prod', true);
            const [distribution] = Object.values(streamTemplate.findResources('AWS::CloudFront::Distribution'));
            const origins = (distribution as any).Properties.DistributionConfig.Origins;
            expect(origins).toHaveLength(2);
            expect(origins[0].Id).toBe('NakomIsApiOrigin');
            expect(origins[1].Id).toBe('NakomIsChatStreamOrigin');
        });
    });

    describe('sandbox', () => {
        const template = synth('sandbox');

        it('adds no bypass behaviours, as nakomis.com is not in sandbox', () => {
            const paths = behaviours(template).map(b => b.PathPattern);
            for (const path of bypassPaths) {
                expect(paths).not.toContain(path);
            }
        });

        it('describes what the sandbox distribution serves', () => {
            template.hasResourceProperties('AWS::CloudFront::Distribution', {
                DistributionConfig: Match.objectLike({
                    Comment: Match.stringLikeRegexp('^sandbox\\.nakom\\.is shortener'),
                }),
            });
        });
    });
});

// HAND-22: hi-* links are uncached and get the viewer headers the hit event is built from.
describe('CloudFront hi-* behaviour', () => {
    describe.each(['prod', 'sandbox'] as DeployEnv[])('%s', (deployEnv) => {
        const template = synth(deployEnv);

        it.each(['hi-*', 'HI-*', 'Hi-*', 'hI-*', 'q??', 'Q??'])('sends %s to the API Gateway origin, uncached, with the redirect function kept', (pattern) => {
            const behaviour = behaviours(template).find(b => b.PathPattern === pattern);
            expect(behaviour).toBeDefined();
            expect(behaviour.TargetOriginId).toBe('NakomIsApiOrigin');
            expect(behaviour.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
            expect(behaviour.AllowedMethods).toEqual(['GET', 'HEAD']);
            expect(behaviour.FunctionAssociations).toEqual([
                expect.objectContaining({ EventType: 'viewer-request' }),
            ]);
            expect(behaviour.OriginRequestPolicyId).toEqual({ Ref: expect.stringMatching(/^HitLinkHeadersPolicy/) });
        });

        it('forwards only the derived-field headers: no Host, no cookies, no query string', () => {
            const [policy] = Object.values(template.findResources('AWS::CloudFront::OriginRequestPolicy')) as any[];
            const config = policy.Properties.OriginRequestPolicyConfig;
            expect(config.HeadersConfig.HeaderBehavior).toBe('whitelist');
            expect([...config.HeadersConfig.Headers].sort()).toEqual([
                'Accept-Language',
                'CloudFront-Is-Desktop-Viewer',
                'CloudFront-Is-Mobile-Viewer',
                'CloudFront-Is-SmartTV-Viewer',
                'CloudFront-Is-Tablet-Viewer',
                'CloudFront-Viewer-City',
                'CloudFront-Viewer-Country',
                'CloudFront-Viewer-Country-Region',
                'User-Agent',
            ]);
            expect(config.CookiesConfig.CookieBehavior).toBe('none');
            expect(config.QueryStringsConfig.QueryStringBehavior).toBe('none');
        });

        it('leaves the default behaviour without an origin request policy', () => {
            const [distribution] = Object.values(template.findResources('AWS::CloudFront::Distribution')) as any[];
            const def = distribution.Properties.DistributionConfig.DefaultCacheBehavior;
            expect(def.OriginRequestPolicyId).toBeUndefined();
            expect(def.CachePolicyId).toBe('658327ea-f89d-4fab-a63d-7e88639e58f6');
        });
    });
});

// CacheHitRate needs CloudFront additional metrics (NAKIS-21), which cost money, so prod only.
describe('CloudFront monitoring subscription', () => {
    it('enables additional metrics in prod', () => {
        synth('prod').hasResourceProperties('AWS::CloudFront::MonitoringSubscription', {
            MonitoringSubscription: {
                RealtimeMetricsSubscriptionConfig: { RealtimeMetricsSubscriptionStatus: 'Enabled' },
            },
        });
    });

    it('leaves additional metrics off in sandbox', () => {
        synth('sandbox').resourceCountIs('AWS::CloudFront::MonitoringSubscription', 0);
    });
});
