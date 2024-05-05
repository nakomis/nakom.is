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

        const anyIntegration = new api.MockIntegration({
            integrationResponses: [
                {
                    statusCode: "405",
                }
            ],
            requestTemplates: {
                'application/json': '{"statusCode": 200}'
            }
        });

        this.addRoot(gateway, anyIntegration);
        this.addRobots(gateway, anyIntegration);
        this.addStatic(gateway, anyIntegration);
    }

    addRoot(gateway: api.RestApi, anyIntegration: api.MockIntegration) {
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

        const anyRoot = gateway.root.addMethod('ANY', anyIntegration, {
            methodResponses: [
                {
                    statusCode: '405'
                }
            ]
        })
    }

    addRobots(gateway: api.RestApi, anyIntegration: api.MockIntegration) {
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

        const robotsResource = gateway.root.addResource('robots.txt');

        const getRobots = robotsResource.addMethod('GET', robotsIntegration, {
            methodResponses: [
                {
                    responseParameters: {
                        "method.response.header.Content-Type": true
                    },
                    statusCode: '200'
                }
            ]
        });

        const anyRoot = robotsResource.addMethod('ANY', anyIntegration, {
            methodResponses: [
                {
                    statusCode: '405'
                }
            ]
        })
    }

    addStatic(gateway: api.RestApi, anyIntegration: api.MockIntegration) {
        const staticResource = gateway.root.addResource('static');
        staticResource.addMethod('ANY', anyIntegration, {
            methodResponses: [
                {
                    statusCode: '405'
                }
            ]
        });

        const staticFileResource = staticResource.addResource('{file+}');
        staticFileResource.addMethod('ANY', anyIntegration, {
            methodResponses: [
                {
                    statusCode: '405'
                }
            ]
        });

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

        const staticFileOptions: api.MethodOptions = {
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
        }

        staticFileResource.addMethod('GET', staticFileIntegration, staticFileOptions);
    }

}
