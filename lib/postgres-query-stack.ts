import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export class PostgresQueryStack extends cdk.Stack {
  public readonly queryFunction: lambda.Function;
  public readonly lambdaSecurityGroupId: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Load configuration
    const configPath = path.join(__dirname, '../config.json');
    let config: any = {};

    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (error) {
      console.warn('config.json not found, using defaults');
      config = {
        database: {
          host: 'your-rds-endpoint',
          port: 5432,
          database: 'analytics',
          username: 'analytics',
          password: 'your-password'
        }
      };
    }

    // Look up the VPC (same one as RDS)
    const vpc = ec2.Vpc.fromLookup(this, 'RdsVpc', {
      vpcId: 'vpc-04203d503fc2fce95'
    });

    // Create security group for Lambda
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'PostgresQueryLambdaSG', {
      vpc,
      securityGroupName: 'postgres-query-lambda-sg',
      description: 'Security group for PostgreSQL query Lambda',
      allowAllOutbound: true, // Needs outbound for RDS connection
    });

    // Create security group for RDS access
    const rdsAccessSecurityGroup = new ec2.SecurityGroup(this, 'RdsAccessSG', {
      vpc,
      securityGroupName: 'rds-access-from-lambda',
      description: 'Allow Lambda access to PostgreSQL RDS',
      allowAllOutbound: false,
    });

    // Allow Lambda to connect to RDS on port 5432
    rdsAccessSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(lambdaSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      'PostgreSQL access from Lambda'
    );

    // Create the Lambda function
    this.queryFunction = new lambda.Function(this, 'PostgresQueryFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/postgres-query'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_11.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output'
          ],
        },
      }),
      handler: 'handler.lambda_handler',
      functionName: 'nakomis-postgres-query',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        DB_HOST: config.database?.host || 'localhost',
        DB_PORT: config.database?.port?.toString() || '5432',
        DB_NAME: config.database?.database || 'analytics',
        DB_USER: config.database?.username || 'analytics',
        DB_PASSWORD: config.database?.password || 'password',
      },
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED, // Use isolated subnets with VPC endpoints
      },
      securityGroups: [lambdaSecurityGroup],
    });

    // Database credentials now come from environment variables (via config.json)

    // Export the Lambda security group ID
    this.lambdaSecurityGroupId = lambdaSecurityGroup.securityGroupId;

    // Output the function name
    new cdk.CfnOutput(this, 'PostgresQueryFunctionName', {
      value: this.queryFunction.functionName,
      description: 'Name of the PostgreSQL query Lambda function'
    });

    // Output the security group that needs to be added to RDS
    new cdk.CfnOutput(this, 'RdsAccessSecurityGroupId', {
      value: rdsAccessSecurityGroup.securityGroupId,
      description: 'Security Group ID to add to RDS for Lambda access'
    });

    // Output example AWS CLI command
    new cdk.CfnOutput(this, 'ExampleInvokeCommand', {
      value: `aws lambda invoke --function-name ${this.queryFunction.functionName} --payload '{"sql":"SELECT version();"}' response.json && cat response.json`,
      description: 'Example command to invoke the Lambda with SQL query'
    });
  }
}