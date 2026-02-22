import * as cdk from 'aws-cdk-lib';
import * as api from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';

import { Function, IFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { CfnApiGatewayManagedOverrides, EndpointType } from 'aws-cdk-lib/aws-apigatewayv2';
import { GetApiKeyCr } from './apikey-cr';
import { LogGroup, QueryDefinition, QueryString, RetentionDays } from 'aws-cdk-lib/aws-logs';

export interface ApiGatewayStackProps extends cdk.StackProps {
    urlShortener: IFunction,
    bucket: s3.Bucket,
    executionRole: iam.Role,
    chatFunction?: IFunction,
}

export class ApiGatewayStack extends cdk.Stack {
    readonly anyIntegration: api.MockIntegration;
    readonly gateway: api.RestApi;
    readonly executionRole: iam.Role;
    readonly bucket: s3.Bucket;
    readonly apiKeyString: string;

    constructor(scope: Construct, id: string, props?: ApiGatewayStackProps) {
        super(scope, id, props);

        this.bucket = props!.bucket;
        this.executionRole = props!.executionRole;

        const logGroup = new LogGroup(this, 'ApiGatewayAccessLogs', {
            logGroupName: '/nakom.is/apigateway/access-log',
            retention: RetentionDays.SIX_MONTHS,
        });

        const savedQuery = new QueryDefinition(this, "ApiGatewayLogInsightQuery", {
            logGroups: [logGroup],
            queryDefinitionName: "Path and IP",
            queryString: new QueryString({
                parseStatements: ['@message "* * *" as path, ip, junk'],
                display: 'path, ip, @timestamp, @message, @logStream, @log',
                limit: 1000,
                sort: '@timestamp desc'
            })
        });

        this.gateway = new api.RestApi(this, 'RestApi', {
            endpointTypes: [EndpointType.REGIONAL],
            restApiName: 'nakom.is',
            binaryMediaTypes: ["*/*"],
            defaultMethodOptions: {
                apiKeyRequired: true
            },
            deployOptions: {
                loggingLevel: api.MethodLoggingLevel.INFO,
                accessLogDestination: new api.LogGroupLogDestination(logGroup),
                accessLogFormat: api.AccessLogFormat.custom(`$context.path $context.identity.sourceIp $context.identity.caller $context.identity.user [$context.requestTime] "$context.httpMethod $context.resourcePath $context.protocol" $context.status $context.responseLength $context.requestId`)
            }
        });

        const apiUsagePlan = this.gateway.addUsagePlan("ApiGatewayUsagePlan", {
            name: 'nakom.isUsagePlan',
            throttle: {
                rateLimit: 5,
                burstLimit: 5
            },
            quota: {
                limit: 1500,
                period: api.Period.DAY
            }
        });
        apiUsagePlan.addApiStage({
            stage: this.gateway.deploymentStage
        });

        // Creating a key with an explicit value will cause a re-deploy to fail
        // with a duplicate key name. CDK seems to consider a new key with a different
        // value to a new resource (with the same name), which precludes creating a key
        // with e.g. `generateRandomString` as the value
        // In addition, it's not possible to read the value of the key directly, so I use
        // a Custom resource to obtain the value
        const apiKey = this.gateway.addApiKey('ApiKey', {
            apiKeyName: 'cfn-nakom.is-app-key'
        });
        this.apiKeyString = new GetApiKeyCr(this, "NISApiKeyGetter", {apiKey: apiKey}).apikeyValue;

        const ssmNISAPIKey = new ssm.StringParameter(this, "NISAPIKeyParam", {
            parameterName: "/nakom.is/nis/apikey",
            description: "API Key for NIS",
            stringValue: this.apiKeyString
        });

        apiUsagePlan.addApiKey(apiKey);

        this.anyIntegration = new api.MockIntegration({
            integrationResponses: [
                {
                    statusCode: "405",
                }
            ],
            requestTemplates: {
                'application/json': JSON.stringify({ statusCode: 0 })
            },
            contentHandling: api.ContentHandling.CONVERT_TO_TEXT
        });

        this.addRoot();
        this.addStatic();
        if (props?.chatFunction) {
            this.addChat(props.chatFunction);
        }
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
                'application/json': JSON.stringify({ statusCode: 0 })
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
                        selectionPattern: "404",
                        responseParameters: {
                            'method.response.header.Location': "'https://www.google.co.uk'",
                            'method.response.header.Content-Type': "'application/json'"
                        },
                        responseTemplates: {
                            'application/xml': '#set($context.responseOverride.header.Location = "https://www.google.com/search?q=" + $method.request.path.file)\n{}'
                        },
                        contentHandling: api.ContentHandling.CONVERT_TO_TEXT
                    }
                ],
                credentialsRole: this.executionRole
            },
            region: this.region,
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

        this.addAny405(staticFileResource);
    }

    addLambda(urlShortener: IFunction) {
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
                'application/json': JSON.stringify({ statusCode: 0 })
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
            { path: "cv", file: "cv.pdf" },
            { path: "wordle", file: "wordle.html" },
            { path: "social", file: "social.html" },
            { path: "robots.txt", file: "robots.txt" },
            { path: "favicon.ico", file: "favicon.ico" },
            { path: "static", file: "static.html", pathExists: true },
            { path: "mu", file: "MUsic.jpeg", download: true},
            { path: "mupic", file: "MUsic.jpeg", download: false},
            { path: "privacy-policy", file: "privacy-policy.pdf" },
            { path: "vimrc", file: ".vimrc", download: true },
        ];

        exceptions.forEach((exception) => {
            const exceptionMethodOptions: api.MethodOptions = {
                methodResponses: [
                    {
                        statusCode: "200",
                        responseParameters: {
                            'method.response.header.Content-Length': false,
                            'method.response.header.Content-Type': false,
                            ...(exception.download && {'method.response.header.Content-Disposition': false})
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

            var exceptionalResource: api.Resource =
                exception.pathExists ? this.gateway.root.getResource(exception.path) as api.Resource
                    : this.gateway.root.addResource(exception.path);

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
                                'method.response.header.Content-Type': 'integration.response.header.Content-Type',
                                ...(exception.download && {'method.response.header.Content-Disposition': `'attachment; filename="${exception.file}"'`})
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
                region: this.region,
                integrationHttpMethod: "GET",
            });
            exceptionalResource.addMethod("GET", exceptionIntegration, exceptionMethodOptions);
            this.addAny405(exceptionalResource);
        })
    }

    addChat(chatFunction: IFunction) {
        const chatResource = this.gateway.root.addResource('chat');

        const chatIntegration = new api.LambdaIntegration(chatFunction, {
            proxy: true,
        });

        chatResource.addMethod('POST', chatIntegration, {
            methodResponses: [
                {
                    statusCode: '200',
                    responseParameters: {
                        'method.response.header.Content-Type': true,
                    },
                },
                {
                    statusCode: '429',
                    responseParameters: {
                        'method.response.header.Content-Type': true,
                    },
                },
            ],
        });

        this.addAny405(chatResource);
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
