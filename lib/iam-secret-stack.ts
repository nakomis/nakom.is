import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface IAMSecretStackProps extends cdk.StackProps {
    redirectsTable: dynamodb.TableV2
}

export class IAMSecretStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: IAMSecretStackProps) {
        super(scope, id, props);

        const user = new iam.User(this, 'NISUser', {
            userName: 'nis'
        });
        const accessKey = new iam.AccessKey(this, 'NISAccessKey', { user });
        const secretAccessKey = new sm.Secret(this, 'NISSecretAccessKeySecret', {
            secretName: 'NISSecretAccessKey',
            secretStringValue: accessKey.secretAccessKey,
        });
        const secretAccssKeyId = new sm.Secret(this, 'NISAccessKeyIdSecret', {
            secretName: 'NISAccessKeyId',
            secretStringValue: cdk.SecretValue.unsafePlainText(accessKey.accessKeyId)
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

