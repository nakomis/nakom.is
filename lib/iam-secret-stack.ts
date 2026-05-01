import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';

import { Construct } from 'constructs';
import { DeployEnv, ssmPrefix } from './deploy-env';

export interface IAMSecretStackProps extends cdk.StackProps {
    redirectsTable: dynamodb.TableV2;
    deployEnv: DeployEnv;
}

export class IAMSecretStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: IAMSecretStackProps) {
        super(scope, id, props);

        const ssmPfx = ssmPrefix(props.deployEnv);

        const user = new iam.User(this, 'NISUser', {
            userName: 'nis'
        });
        const accessKey = new iam.AccessKey(this, 'NISAccessKey', { user });

        new ssm.StringParameter(this, "NISAccessKeyIdParam", {
            parameterName: `${ssmPfx}nis/accessKeyId`,
            description: "Access key ID for the NIS user",
            stringValue: accessKey.accessKeyId
        });

        new ssm.StringParameter(this, "NISSecretAccessKeyParam", {
            parameterName: `${ssmPfx}nis/secretAccessKey`,
            description: "Secret access key for the NIS user",
            stringValue: accessKey.secretAccessKey.unsafeUnwrap()
        });

        props.redirectsTable.grant(user,
            'dynamodb:DeleteItem',
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:Scan'
        );
    }
};
