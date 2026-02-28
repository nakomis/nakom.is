import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export class PostgresQueryStack extends cdk.Stack {
  readonly queryFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Log Group for PostgreSQL query Lambda
    const logGroup = new LogGroup(this, 'PostgresQueryLogs', {
      logGroupName: '/nakom.is/lambda/postgres-query',
      retention: RetentionDays.ONE_WEEK, // Short retention for admin tool
    });

    // PostgreSQL Query Lambda Function (no permissions - admin will invoke manually)
    this.queryFunction = new NodejsFunction(this, 'PostgresQueryFunction', {
      functionName: 'postgres-query',
      entry: 'lambda/postgres-query/handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512, // More memory for database operations
      timeout: Duration.minutes(5), // Generous timeout for complex queries
      logGroup: logGroup,
      environment: {
        // Connection details can be set here or passed via event
        // POSTGRES_HOST: 'your-rds-endpoint.region.rds.amazonaws.com',
        // POSTGRES_DATABASE: 'your_database',
        // POSTGRES_USER: 'your_username',
        // POSTGRES_PASSWORD: 'your_password', // Better to use Secrets Manager
        // POSTGRES_SSL: 'true',
      },
      bundling: {
        minify: false, // Keep readable for debugging
        sourceMap: true,
      },
    });

    // Output the function name for easy console invocation
    new cdk.CfnOutput(this, 'FunctionName', {
      value: this.queryFunction.functionName,
      description: 'PostgreSQL query Lambda function name',
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: this.queryFunction.functionArn,
      description: 'PostgreSQL query Lambda function ARN',
    });
  }
}