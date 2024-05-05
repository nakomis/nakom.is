import * as cdk from 'aws-cdk-lib';
import * as api from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Function } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface NakomIsStackProps extends cdk.StackProps {
    urlShortener: Function,
    bucket: s3.Bucket,
    executionRole: iam.Role
}

export class NakomIsStack extends cdk.Stack {
    readonly anyIntegration: api.MockIntegration;
    readonly gateway: api.RestApi;
    readonly executionRole: iam.Role;
    readonly bucket: s3.Bucket;

    constructor(scope: Construct, id: string, props?: NakomIsStackProps) {
        super(scope, id, props);

        this.bucket = props!.bucket;
        this.executionRole = props!.executionRole;

        this.gateway = new api.RestApi(this, 'RestApi', {
            restApiName: 'nakom.is',
            binaryMediaTypes: ["*/*"],
        });

        this.anyIntegration = new api.MockIntegration({
            integrationResponses: [
                {
                    statusCode: "405",
                }
            ],
            requestTemplates: {
                'application/json': JSON.stringify({statusCode: 0})
            }
        });

        this.addRoot();
        this.addStatic();
        this.addLambda(props!.urlShortener);
        this.addExceptions();

    }

    addRoot() {
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
                'application/json': JSON.stringify({statusCode: 0})
            }
        });

        const getRoot = this.gateway.root.addMethod('GET', rootIntegration, {
            methodResponses: [
                {
                    responseParameters: {
                        "method.response.header.Location": true
                    },
                    statusCode: '301'
                }
            ]
        });

        this.addAny405(this.gateway.root);
    }

    addStatic() {
        const staticResource = this.gateway.root.addResource('static');
        const staticFileResource = staticResource.addResource('{file+}');

        const staticFileIntegration = new api.AwsIntegration({
            service: 's3',
            path: `${this.bucket.bucketName}/{s3file}`,
            options: {
                passthroughBehavior: api.PassthroughBehavior.WHEN_NO_MATCH,
                requestParameters: {
                    "integration.request.path.s3file": 'method.request.path.file'
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
                credentialsRole: this.executionRole
            },
            region: "eu-west-2",
            integrationHttpMethod: "GET",
        });

        const staticMethodOptions: api.MethodOptions = {
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
                        "application/octet-stream": {
                            modelId: "Empty"
                        },
                        "application/pdf": {
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

        staticFileResource.addMethod('GET', staticFileIntegration, staticMethodOptions);

        this.addAny405(staticResource);
        this.addAny405(staticFileResource);
    }

    addLambda(urlShortener: Function) {
        const lambdaIntegration = new api.LambdaIntegration(urlShortener, {
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
                'application/json': JSON.stringify({statusCode: 0})
            }
        });

        const lambdaResource = this.gateway.root.addResource('{shortPath+}');

        lambdaResource.addMethod('GET', lambdaIntegration, {
            methodResponses: [
                {
                    responseParameters: {
                        "method.response.header.Content-Type": true
                    },
                    statusCode: '200'
                }
            ]
        });

        this.addAny405(lambdaResource);
    }

    addExceptions() {
        const exceptions = [
            {
                "path": "cv",
                "file": "cv.pdf"
            },
            {
                "path": "wordle",
                "file": "wordle.html"
            },
            {
                "path": "robots.txt",
                "file": "robots.txt"
            },
            {
                "path": "favicon.ico",
                "file": "favicon.ico"
            }
        ];

        const exceptionMethodOptions: api.MethodOptions = {
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
                        "application/octet-stream": {
                            modelId: "Empty"
                        },
                        "application/pdf": {
                            modelId: "Empty"
                        }
                    }
                }
            ]
        };

        exceptions.forEach((exception) => {
            const exceptionalResource = this.gateway.root.addResource(exception.path);
            const exceptionIntegration = new api.AwsIntegration({
                service: 's3',
                path: `${this.bucket.bucketName}/{s3file}`,
                options: {
                    passthroughBehavior: api.PassthroughBehavior.WHEN_NO_MATCH,
                    requestParameters: {
                        "integration.request.path.s3file": `'${exception.file}'`
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
                    credentialsRole: this.executionRole
                },
                region: "eu-west-2",
                integrationHttpMethod: "GET",
            });
            exceptionalResource.addMethod("GET", exceptionIntegration, exceptionMethodOptions);
            this.addAny405(exceptionalResource);
        })
    }

    addAny405(resource: cdk.aws_apigateway.IResource) {
        resource.addMethod("ANY", this.anyIntegration, {
            methodResponses: [
                {
                    statusCode: '405'
                }
            ]        
        })
    }
}
