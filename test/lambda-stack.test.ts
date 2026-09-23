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
