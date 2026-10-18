import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { DeployEnv, envSuffix } from './deploy-env';

export interface MonitoringStackProps extends cdk.StackProps {
    deployEnv: DeployEnv;
}

/**
 * At-a-glance health dashboard (NAKIS-21). Everything is addressed by name
 * (the REST API name and the suffixed function names the other stacks set), so
 * this stack takes no cross-stack references and can be deployed or removed on
 * its own.
 */
export class MonitoringStack extends cdk.Stack {
    readonly dashboard: cw.Dashboard;

    constructor(scope: Construct, id: string, props: MonitoringStackProps) {
        super(scope, id, props);

        const suffix = envSuffix(props.deployEnv);
        const period = Duration.minutes(5);

        // Set in ApiGatewayStack; the same in both environments (separate accounts).
        const apiName = 'nakom.is';
        // Set in ChatStack, LambdaStack and CvStack respectively.
        const functionNames = [
            `nakomis-chat${suffix}`,
            `nakomis-chat-stream${suffix}`,
            `nakomis-blog-search${suffix}`,
            `urlShortener${suffix}`,
            `nakomis-cv${suffix}`,
        ];

        const apiMetric = (metricName: string, statistic: string) => new cw.Metric({
            namespace: 'AWS/ApiGateway',
            metricName,
            dimensionsMap: { ApiName: apiName },
            statistic,
            period,
        });

        const lambdaMetrics = (metricName: string, statistic: string) => functionNames.map(functionName =>
            new cw.Metric({
                namespace: 'AWS/Lambda',
                metricName,
                dimensionsMap: { FunctionName: functionName },
                statistic,
                period,
                label: functionName,
            }));

        // CloudFront metrics live in us-east-1. CacheHitRate only exists for a
        // distribution with additional metrics turned on (CloudfrontStack, prod
        // only), so a search finds it without importing the distribution ID.
        const cacheHitRate = new cw.MathExpression({
            expression: `SEARCH('{AWS/CloudFront,DistributionId,Region} MetricName="CacheHitRate"', 'Average', ${period.toSeconds()})`,
            usingMetrics: {},
            label: 'Cache hit rate',
            period,
            searchRegion: 'us-east-1',
        });

        this.dashboard = new cw.Dashboard(this, 'HealthDashboard', {
            dashboardName: `nakomis-health${suffix}`,
            defaultInterval: Duration.days(1),
        });

        this.dashboard.addWidgets(
            new cw.GraphWidget({
                title: 'API Gateway requests',
                left: [apiMetric('Count', 'Sum').with({ label: 'Requests' })],
                width: 8,
            }),
            new cw.GraphWidget({
                title: 'API Gateway error rate (%)',
                left: [
                    new cw.MathExpression({
                        expression: '100 * e4',
                        usingMetrics: { e4: apiMetric('4XXError', 'Average') },
                        label: '4XX',
                        period,
                    }),
                    new cw.MathExpression({
                        expression: '100 * e5',
                        usingMetrics: { e5: apiMetric('5XXError', 'Average') },
                        label: '5XX',
                        period,
                    }),
                ],
                leftYAxis: { min: 0, showUnits: false },
                width: 8,
            }),
            new cw.GraphWidget({
                title: 'CloudFront cache hit rate (%)',
                region: 'us-east-1',
                left: [cacheHitRate],
                leftYAxis: { min: 0, max: 100, showUnits: false },
                width: 8,
            }),
        );

        this.dashboard.addWidgets(
            new cw.GraphWidget({
                title: 'Lambda duration (p95)',
                left: lambdaMetrics('Duration', 'p95'),
                width: 12,
            }),
            new cw.GraphWidget({
                title: 'Lambda errors',
                left: lambdaMetrics('Errors', 'Sum'),
                leftYAxis: { min: 0 },
                width: 12,
            }),
        );
    }
}
