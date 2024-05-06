# Nakom.is

![Architecture](architecture/nakom.is%20architecture.drawio.svg)

Deployment order:

* S3Stack
* LambdaStack
* NakomIsStack
* Route53Stack
* CertificateStack
    * Manually set the DNS records
* CloudfrontStack
* Route53AdditionalStack