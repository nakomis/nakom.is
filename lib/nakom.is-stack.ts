import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as api from 'aws-cdk-lib/aws-apigateway';
import { Role } from 'aws-cdk-lib/aws-iam';


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

    // FIXME: Create the role as part of this stack
    const myrole = Role.fromRoleArn(this, "S3Role", "arn:aws:iam::637423226886:role/MHnakom.isReadS3");

    // Static files
    const staticResource = gateway.root.addResource('static');
    const staticFileResource = staticResource.addResource('{file+}');


    const staticFileIntegration = new api.AwsIntegration({
      service: "s3",
      path: "mhtestfornakom.is/{abc}",
      options: {
        passthroughBehavior: api.PassthroughBehavior.WHEN_NO_MATCH,
        requestParameters: {
          "integration.request.path.abc": 'method.request.path.file'
        },
        integrationResponses: [{
          statusCode: "200",
          responseParameters: {
            'method.response.header.Content-Length': 'integration.response.header.Content-Length',
            'method.response.header.Content-Type': 'integration.response.header.Content-Type'
          }
        }],
        credentialsRole: myrole
      },
      region: "eu-west-2",
      integrationHttpMethod: "GET",
    });

    const getStaticFile = staticFileResource.addMethod('GET', staticFileIntegration, {
      requestParameters: {
        'method.request.path.file': true
      },
      methodResponses: [{
        statusCode: "200",
        responseParameters: {
          'method.response.header.Content-Length': false,
          'method.response.header.Content-Type': false
        },
        responseModels: {
          "application/json": {
            modelId: "Empty"
          }
        }
      }]
    });


    // let awsS3IntegrationFolderItemHeadProps = new api.AwsIntegration({
    //   service: 's3',
    //   path: '{bucket}/{object}',
    //   options: {
    //     passthroughBehavior: api.PassthroughBehavior.WHEN_NO_MATCH,
    //     credentialsRole: this.apiGatewayRole,
    //     requestParameters: {
    //       'integration.request.path.bucket': 'method.request.path.folder',
    //       'integration.request.path.object': 'method.request.path.item'
    //     },
    //     integrationResponses: [{
    //         statusCode: "200",
    //         responseParameters: {
    //           'method.response.header.Content-Length': 'integration.response.header.Content-Length',
    //           'method.response.header.Content-Type': 'integration.response.header.Content-Type'
    //         }
    //       },
    //       {
    //         statusCode: "400",
    //         selectionPattern: "4\\d{2}"
    //       },
    //       {
    //         statusCode: "500",
    //         selectionPattern: "5\\d{2}"
    //       }
    //     ]
    //   },
    //   integrationHttpMethod: "HEAD"
    // })

    // let apiGatewayResourceItemHead = this.apiGatewayResourceItem.addMethod("HEAD",awsS3IntegrationFolderItemHeadProps,methodOptionFolderItemHeadProps)

    // let methodOptionFolderItemHeadProps = {
    //   authorizationType: api.AuthorizationType.IAM,
    //   requestParameters: {
    //     'method.request.path.folder': true,
    //     "method.request.path.item": true
    //   },
    //   methodResponses: [{
    //       statusCode: "200",
    //       responseParameters: {
    //         'method.response.header.Content-Length': false,
    //         'method.response.header.Content-Type': false
    //       },
    //       responseModels: {
    //         "application/json": {
    //           modelId: "Empty"
    //         }
    //       }
    //     },
    //     {
    //       statusCode: "400",
    //     },
    //     {
    //       statusCode: "500",
    //     }
    //   ]
    // }

  }
}
