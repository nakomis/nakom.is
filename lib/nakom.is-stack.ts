import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as api from 'aws-cdk-lib/aws-apigateway';


export class NakomIsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Table
    const redirectTable = new TableV2(this, 'redirects', {
      tableName: 'redirects',
      partitionKey: { name: 'shortPath', type: AttributeType.STRING },
    });

    // Lambda Function
    const redirectsFunction = new lambda.Function(this, 'RedirectsFunction', {
      functionName: 'urlShortener',
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'urlshortener.lambda_handler'
    });

    redirectTable.grantReadWriteData(redirectsFunction);

    // API Gateway
    const gateway = new api.RestApi(this, 'RestApi', {
      restApiName: 'nakom.is'
    });

    // root resource
    const rootIntegration = new api.MockIntegration({
      integrationResponses: [
        {
          statusCode: "301",
          contentHandling: api.ContentHandling.CONVERT_TO_TEXT,
          responseTemplates: {
            'application/json': ''
          },
          responseParameters: {
            "method.response.header.Location": "'https://www.google.co.uk/'"
          }
        }
      ],
      requestTemplates: {
        'application/json': '{"statusCode": 200}'
      }
    });

    const getRoot = gateway.root.addMethod('GET', rootIntegration, {
      methodResponses: [
        {
          responseParameters: {
            "method.response.header.Location": true
          },
          statusCode: '301'
        }
      ]
    });

    // robots.txt
    const robotsIntegration = new api.MockIntegration({
      integrationResponses: [
        {
          statusCode: "200",
          contentHandling: api.ContentHandling.CONVERT_TO_TEXT,
          responseTemplates: {
            'text/plain': 'User-agent: *\nDisallow: /\n'
          },
          responseParameters: {
            "method.response.header.Content-Type": "'text/plain'"
          }
        }
      ],
      requestTemplates: {
        'application/json': '{"statusCode": 200}'
      }
    });

    const getRobots = gateway.root.addResource('robots.txt').addMethod('GET', robotsIntegration, {
      methodResponses: [
        {
          responseParameters: {
            "method.response.header.Content-Type": true
          },
          statusCode: '200'
        }
      ]
    });

    // Static files
    const staticResource = gateway.root.addResource('static');
    const staticFileResource = staticResource.addResource('{file+}');

    const staticFileIntegration = new api.AwsIntegration({
      service: "s3",
      region: "eu-west-2",
      integrationHttpMethod: "GET",
      path: "mhtestfornakom.is/{abc}",
      options: {
        requestParameters: {
          "abc": "method.request.path.file"
        }
      }
    });

    const getStaticFile = staticFileResource.addMethod('GET', staticFileIntegration)
  }
}
