import * as cdk from 'aws-cdk-lib';
import * as api from 'aws-cdk-lib/aws-apigateway';
import { Role } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface NakomIsStackProps extends cdk.StackProps {

}

export class NakomIsStack extends cdk.Stack {

    constructor(scope: Construct, id: string, props?: NakomIsStackProps) {
        super(scope, id, props);

        const gateway = new api.RestApi(this, 'RestApi', {
            restApiName: 'nakom.is'
        });

        this.addRoot(gateway);
        this.addRobots(gateway);
        this.addStatic(gateway);
    }

    addRoot(gateway: api.RestApi) {
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
    }

    addRobots(gateway: api.RestApi) {
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
    }

    addStatic(gateway: api.RestApi) {
        const staticResource = gateway.root.addResource('static');
        const staticFileResource = staticResource.addResource('{file+}');

        // FIXME: Create the role as part of this stack
        const myrole = Role.fromRoleArn(this, "S3Role", "arn:aws:iam::637423226886:role/MHnakom.isReadS3");

        const staticFileIntegration = new api.AwsIntegration({
            service: "s3",
            path: "mhtestfornakom.is/{abc}",
            options: {
                passthroughBehavior: api.PassthroughBehavior.WHEN_NO_MATCH,
                requestParameters: {
                    "integration.request.path.abc": 'method.request.path.file'
                },
                integrationResponses: [
                    {
                    statusCode: "200",
                    responseParameters: {
                        'method.response.header.Content-Length': 'integration.response.header.Content-Length',
                        'method.response.header.Content-Type': 'integration.response.header.Content-Type'
                    }
                },
                {
                    statusCode: "301",
                    selectionPattern: "403",
                    responseParameters: {
                        'method.response.header.Location': "'https://www.google.co.uk'"
                    },
                    responseTemplates: {
                        'text/plain': 'Not Found'
                    }
                }
            ],
                credentialsRole: myrole
            },
            region: "eu-west-2",
            integrationHttpMethod: "GET",
        });

        const getStaticFile = staticFileResource.addMethod('GET', staticFileIntegration, {
            requestParameters: {
                'method.request.path.file': true
            },
            methodResponses: [
                {
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
                },
                {
                    statusCode: "301",
                    responseParameters: {
                        'method.response.header.Location': true
                    },
                    responseModels: {
                        "application/json": {
                            modelId: "Empty"
                        }
                    }
                }
            ]
        });
    }

}
