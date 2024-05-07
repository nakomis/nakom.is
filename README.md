# Nakom.is

![Architecture](architecture/nakom.is%20architecture.drawio.svg)

Deployment order:

* S3Stack
* LambdaStack
* NakomIsStack
* Route53Stack
* https://github.com/nakomis/nakom.is-certificate
* CertificateValidationStack
    * Manual copy the DNS Challenge from the nakom.is-certificate certificate
* CloudfrontStack
* Route53AdditionalStack