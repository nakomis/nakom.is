import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { LambdaStack } from '../lib/lambda-stack';

// One Roles Anywhere identity per Mac running the Plane MCP (HOME-392).
describe('Plane MCP sync roles', () => {
    const app = new cdk.App();
    const stack = new LambdaStack(app, 'TestLambdaStack', {
        env: { account: '123456789012', region: 'eu-west-2' },
        deployEnv: 'prod',
    });
    const template = Template.fromStack(stack);

    it.each([
        ['plane-mcp', 'plane-mcp-sync'],
        ['plane-mcp-mu', 'plane-mcp-sync-mu'],
    ])('pins the %s certificate to its own role, %s', (cn, roleName) => {
        template.hasResourceProperties('AWS::IAM::Role', {
            RoleName: roleName,
            AssumeRolePolicyDocument: {
                Statement: Match.arrayWith([Match.objectLike({
                    Condition: Match.objectLike({
                        StringEquals: { 'aws:PrincipalTag/x509Subject/CN': cn },
                    }),
                })]),
            },
        });
        template.hasResourceProperties('AWS::RolesAnywhere::Profile', { Name: roleName });
        template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/nakom.is/${cn}/cn`, Value: cn });
    });

    it('lets each role read only its own renewal parameters', () => {
        const policies = template.findResources('AWS::IAM::Policy');
        const ssmResources = Object.values(policies).flatMap((p: any) =>
            p.Properties.PolicyDocument.Statement
                .filter((s: any) => s.Action === 'ssm:GetParameter')
                .map((s: any) => JSON.stringify(s.Resource)));
        expect(ssmResources).toHaveLength(2);
        expect(ssmResources.filter(r => r.includes('parameter/plane-mcp/prod/'))).toHaveLength(1);
        expect(ssmResources.filter(r => r.includes('parameter/plane-mcp-mu/prod/'))).toHaveLength(1);
    });

    it("keeps Phi's original construct IDs, so its role is not replaced", () => {
        const ids = Object.keys(template.findResources('AWS::IAM::Role'));
        expect(ids.some(id => id.startsWith('PlaneMcpSyncRole'))).toBe(true);
        expect(ids.some(id => id.startsWith('PlaneMcpMuSyncRole'))).toBe(true);
    });
});

// HAND-22: hit events for hi- links.
describe('shortener hit queue', () => {
    const app = new cdk.App();
    const stack = new LambdaStack(app, 'TestHitsStack', {
        env: { account: '123456789012', region: 'eu-west-2' },
        deployEnv: 'prod',
    });
    const template = Template.fromStack(stack);

    const statementsFor = (roleLogicalIdPrefix: string) => {
        const policies = Object.values(template.findResources('AWS::IAM::Policy')) as any[];
        return policies
            .filter(p => p.Properties.Roles.some((r: any) => r.Ref?.startsWith(roleLogicalIdPrefix)))
            .flatMap(p => p.Properties.PolicyDocument.Statement);
    };
    const sqsActions = (statements: any[]) =>
        statements.flatMap(s => [s.Action].flat()).filter((a: string) => a.startsWith('sqs:')).sort();

    it('creates the queue and its DLQ, retained, encrypted, five receives before the DLQ', () => {
        template.hasResourceProperties('AWS::SQS::Queue', {
            QueueName: 'nakomis-shortener-hits',
            SqsManagedSseEnabled: true,
            RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
        });
        template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'nakomis-shortener-hits-dlq' });
        const queues = template.findResources('AWS::SQS::Queue');
        for (const q of Object.values(queues) as any[]) {
            expect(q.DeletionPolicy).toBe('Retain');
        }
    });

    it('tells the Lambda where the queue is', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'urlShortener',
            Environment: { Variables: Match.objectLike({ HITS_QUEUE_URL: Match.anyValue() }) },
        });
    });

    it('lets the Lambda send and nothing else on the queue', () => {
        expect(sqsActions(statementsFor('RedirectsFunctionServiceRole'))).toEqual(['sqs:SendMessage']);
    });

    it('lets the Cal consumer receive and delete, but not send', () => {
        const actions = sqsActions(statementsFor('HitsConsumerRole'));
        expect(actions).toEqual([
            'sqs:ChangeMessageVisibility',
            'sqs:DeleteMessage',
            'sqs:GetQueueAttributes',
            'sqs:ReceiveMessage',
        ]);
        expect(actions).not.toContain('sqs:SendMessage');
    });

    it('is the only role other than the Lambda with rights on the queue', () => {
        const policies = Object.values(template.findResources('AWS::IAM::Policy')) as any[];
        const withSqs = policies.filter(p => sqsActions(p.Properties.PolicyDocument.Statement).length > 0);
        const roles = withSqs.flatMap(p => p.Properties.Roles.map((r: any) => r.Ref)).sort();
        expect(roles).toHaveLength(2);
        expect(roles[0]).toMatch(/^HitsConsumerRole/);
        expect(roles[1]).toMatch(/^RedirectsFunctionServiceRole/);
    });

    it('pins the consumer role to its certificate CN', () => {
        template.hasResourceProperties('AWS::IAM::Role', {
            RoleName: 'shortener-hits-consumer',
            AssumeRolePolicyDocument: {
                Statement: Match.arrayWith([Match.objectLike({
                    Condition: Match.objectLike({
                        StringEquals: { 'aws:PrincipalTag/x509Subject/CN': 'shortener-hits-consumer' },
                    }),
                })]),
            },
        });
        template.hasResourceProperties('AWS::RolesAnywhere::Profile', { Name: 'shortener-hits-consumer' });
    });

    it.each([
        'queue-url', 'queue-arn', 'dlq-url', 'dlq-arn',
        'consumer-role-arn', 'consumer-profile-arn', 'trust-anchor-arn', 'consumer-cn',
    ])('publishes /nakom.is/shortener-hits/%s for Cal\'s playbook', (name) => {
        template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/nakom.is/shortener-hits/${name}` });
    });
});
