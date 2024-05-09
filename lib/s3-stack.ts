import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { RemovalPolicy } from 'aws-cdk-lib';

export interface S3StackProps extends cdk.StackProps {

}

export class S3Stack extends cdk.Stack {
    readonly bucketname = 'nakom.is-static';
    readonly bucket: s3.Bucket;
    readonly executionrole: iam.Role;

    constructor(scope: Construct, id: string, props?: S3StackProps) {
        super(scope, id, props);

        this.bucket = new s3.Bucket(this, 'Bucket', {
            bucketName: this.bucketname,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            versioned: false,
            removalPolicy: RemovalPolicy.RETAIN,
        });

        // Grab the nakom.is bucket to prevent cyber-squatting
        new s3.Bucket(this, "nakom.isBucket", {
            bucketName: 'nakom.is',
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            versioned: false,
            removalPolicy: RemovalPolicy.RETAIN,
        });

        // Create a role to allow the API gateway to access the bucket
        this.executionrole = new iam.Role(this, "ReadS3BucketRole", {
            assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
            path: "/service-role/"
        });
        this.bucket.grantRead(this.executionrole);
    }

    s3bucket(): s3.Bucket {
        return this.bucket;
    }

    executionRole(): iam.Role {
        return this.executionrole;
    }
};