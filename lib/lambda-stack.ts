import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import * as rolesanywhere from 'aws-cdk-lib/aws-rolesanywhere';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DeployEnv, envSuffix, logPrefix, ssmPrefix } from './deploy-env';

export interface LambdaStackProps extends cdk.StackProps {
    deployEnv: DeployEnv;
}

export class LambdaStack extends cdk.Stack {
    /**
     * One Roles Anywhere identity per Mac running the Plane MCP (HOME-392).
     * Each has its own CN, role, profile and renewal parameters, so CloudTrail
     * can tell the Macs apart and one can be revoked without the other. The
     * `id` prefixes construct IDs; Phi's is the original, so it must not change
     * or CloudFormation would replace the role it is using.
     */
    static readonly PLANE_MCP_IDENTITIES = [
        { cn: 'plane-mcp', id: 'PlaneMcp', name: 'plane-mcp-sync' },
        { cn: 'plane-mcp-mu', id: 'PlaneMcpMu', name: 'plane-mcp-sync-mu' },
    ] as const;

    readonly redirectsFunction: lambda.Function;
    readonly redirectsFunctionAlias: lambda.Alias;
    readonly redirectTable: dynamodb.TableV2;
    readonly ticketProjectsTable: dynamodb.TableV2;

    constructor(scope: Construct, id: string, props: LambdaStackProps) {
        super(scope, id, props);

        const suffix = envSuffix(props.deployEnv);
        const logPfx = logPrefix(props.deployEnv);

        // DynamoDB Table
        this.redirectTable = new dynamodb.TableV2(this, 'redirects', {
            tableName: `redirects${suffix}`,
            partitionKey: { name: 'shortPath', type: dynamodb.AttributeType.STRING },
        });

        // Maps a ticket project alias (e.g. "home") to a URL template containing {ref}.
        // Rows are data, not infrastructure: edit them in the console or CLI, no deploy needed.
        this.ticketProjectsTable = new dynamodb.TableV2(this, 'TicketProjects', {
            tableName: `ticket-projects${suffix}`,
            partitionKey: { name: 'alias', type: dynamodb.AttributeType.STRING },
        });

        // Create a CloudWatch Log Group for storing access logs
        const logGroup = new LogGroup(this, 'LambdaAccessLogs', {
            logGroupName: `${logPfx}/lambda/urlShortener`,
            retention: RetentionDays.SIX_MONTHS,
        });

        // Lambda Function (esbuild bundled by CDK). NodejsFunction bundles only
        // this handler's own entry point, so the asset stays small.
        this.redirectsFunction = new NodejsFunction(this, 'RedirectsFunction', {
            functionName: `urlShortener${suffix}`,
            entry: 'lambda/shortener/handler.ts',
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_24_X,
            memorySize: 256,
            logGroup: logGroup,
            timeout: Duration.seconds(10),
            environment: {
                // Table names are environment-suffixed, so the function must be told
                // which ones to use rather than hardcoding the production names.
                REDIRECTS_TABLE: this.redirectTable.tableName,
                TICKET_PROJECTS_TABLE: this.ticketProjectsTable.tableName,
            },
            bundling: {
                minify: true,
                sourceMap: true,
            },
        });

        this.redirectsFunctionAlias = new lambda.Alias(this, 'RedirectsFunctionAlias', {
            aliasName: 'live',
            version: this.redirectsFunction.currentVersion,
            provisionedConcurrentExecutions: 1,
        });

        this.redirectTable.grant(this.redirectsFunction, "dynamodb:UpdateItem");
        this.ticketProjectsTable.grant(this.redirectsFunction, "dynamodb:GetItem");

        for (const identity of LambdaStack.PLANE_MCP_IDENTITIES) {
            this.addPlaneMcpSyncRole(props.deployEnv, identity);
        }
    }

    /**
     * Lets the Plane MCP on one of Martin's Macs keep ticket-projects in step with Plane
     * (a row per project, written when the MCP creates one). It authenticates
     * with IAM Roles Anywhere, reusing the home CA trust anchor that
     * home-servers' ConversationMemoryIngestStack publishes, so no long-lived
     * AWS keys live on the Mac.
     */
    private addPlaneMcpSyncRole(
        deployEnv: DeployEnv,
        { cn, id, name: baseName }: typeof LambdaStack.PLANE_MCP_IDENTITIES[number],
    ) {
        // Dynamic reference rather than valueForStringParameter: the latter
        // synthesises a CloudFormation parameter, and an ARN threaded through
        // one cannot be used in an IAM condition at synth time.
        const trustAnchorArn = `{{resolve:ssm:/conversation-memory/${deployEnv}/trust-anchor-arn}}`;

        const role = new iam.Role(this, `${id}SyncRole`, {
            roleName: `${baseName}${envSuffix(deployEnv)}`,
            description: 'Plane MCP: keep the ticket-projects table in step with Plane',
            assumedBy: new iam.ServicePrincipal('rolesanywhere.amazonaws.com', {
                conditions: {
                    ArnEquals: { 'aws:SourceArn': trustAnchorArn },
                    // Pinned to the CN, so a certificate issued for any other
                    // component cannot assume this role.
                    StringEquals: { 'aws:PrincipalTag/x509Subject/CN': cn },
                },
            }),
            maxSessionDuration: Duration.hours(1),
        });

        // Roles Anywhere needs TagSession and SetSourceIdentity alongside
        // AssumeRole to project the certificate's subject into session tags.
        // The CN condition is deliberately absent here: the tag it tests is
        // populated by this very call, so requiring it would deadlock.
        role.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
            actions: ['sts:TagSession', 'sts:SetSourceIdentity'],
            principals: [new iam.ServicePrincipal('rolesanywhere.amazonaws.com')],
            conditions: { ArnEquals: { 'aws:SourceArn': trustAnchorArn } },
        }));

        // UpdateItem only: the MCP upserts rows, merging into any existing
        // attributes. No DeleteItem, so hand-added aliases can't be removed,
        // and no read of the redirects table or anything else.
        this.ticketProjectsTable.grant(role, 'dynamodb:UpdateItem');

        // The Mac fetches its own renewed certificate with the one it holds
        // (HOME-389). The home cert portal renews it automatically and
        // publishes the pair to these two parameters, named after the CN;
        // granting read here means no admin credentials are involved, and a
        // certificate that has already expired can't fetch its successor.
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: ['client-cert', 'client-key'].map(name =>
                `arn:aws:ssm:${this.region}:${this.account}:parameter/${cn}/${deployEnv}/${name}`),
        }));
        // The key is a SecureString. Decrypt only through SSM, never as a
        // general-purpose KMS grant.
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: ['*'],
            conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
        }));

        const profile = new rolesanywhere.CfnProfile(this, `${id}SyncProfile`, {
            name: `${baseName}${envSuffix(deployEnv)}`,
            enabled: true,
            roleArns: [role.roleArn],
            durationSeconds: Duration.hours(1).toSeconds(),
        });

        const params: Record<string, string> = {
            'role-arn': role.roleArn,
            'profile-arn': profile.attrProfileArn,
            'trust-anchor-arn': trustAnchorArn,
            'table-name': this.ticketProjectsTable.tableName,
            'cn': cn,
        };
        for (const [name, value] of Object.entries(params)) {
            new ssm.StringParameter(this, `${id}Param${name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`, {
                parameterName: `${ssmPrefix(deployEnv)}${cn}/${name}`,
                stringValue: value,
            });
        }
    }

    getLambda(): lambda.Function {
        return this.redirectsFunction;
    }

    getLambdaAlias(): lambda.IFunction {
        return this.redirectsFunctionAlias;
    }
};
