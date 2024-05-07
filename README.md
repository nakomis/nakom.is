# nakom.is - A URL Shortener using AWS

The purpose of this project is to create a URL shortener to redirect URLs such as [nakom.is/w](https://nakom.is/w) to any specified URL. In this case, the BBC Weather page for my part of Edinburgh.

## Table of Contents
<!-- toc -->

- [Architecture Diagram](#architecture-diagram)
- [Components](#components)
  * [Domain Registration](#domain-registration)
  * [Route53](#route53)
  * [Cloudfront](#cloudfront)
  * [Certificate Manager](#certificate-manager)
  * [API Gateway (nakom.is)](#api-gateway-nakomis)
  * [Lambda function & DynamodDb](#lambda-function--dynamoddb)
  * [S3 Bucket](#s3-bucket)
  * [Additional Route53 Records](#additional-route53-records)
  * [Creating, listing, and deleting shortcuts](#creating-listing-and-deleting-shortcuts)
- [Deployment order](#deployment-order)

<!-- tocstop -->

## Architecture Diagram
![Architecture](architecture/nakom.is%20architecture.drawio.svg)

## Components
### Domain Registration
As of writing, it is not possible to register a .is domain with AWS Route53 as they can only be registered with an Icelandic registrar. I used [isnic.is](https://www.isnic.is/en) to register the [nakom.is](https://nakom.is) domain.

In addition, I'd already registerd the two other domains I wanted to use, [nakomis.com](https://nakomis.com) and [nakomis.co.uk](https://nakomis.co.uk) in a different AWS account, so I simply followed the [AWS Docs](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-transfer-between-aws-accounts.html) to transfer them to the account I'm using for this project.

As the domain registration occurs outwith the CloudFront stacks created by this project, a manual step is required to redelegate the domains once the Route53 hosted zones have been created. It may have been possible to do this automatically for the two domains registered with Route53, but a manual step would still have been required for the ISNIC registration.

### Route53
The [Route53](lib/route53-stack.ts) stack is used to create the Route53 hosted zones, and  DNS _A Alias_ records which point to the Cloudfront distribution.

In addition, I had a bunch of existing records for MX records and various other projects. I wanted to maintain these records, so I wrote the [utils/getroute53.is](utils/getroute53.is) script to download the records to [JSON files](https://github.com/nakomis/nakom.is/tree/main/route53). The Route53 stack then [parses](lib/route53-stack.ts#L39-L89) these records and adds them to the new hosted zone.

### Cloudfront
### Certificate Manager
### API Gateway (nakom.is)
### Lambda function & DynamodDb
### S3 Bucket
### Additional Route53 Records
### Creating, listing, and deleting shortcuts


## Deployment order

* Domain Registration
  * Manually Register nakom.is with ISNIC
  * Manually Register nakomis.com and nakomis.co.uk with AWS Registrar
* S3Stack
* LambdaStack
* ApiStack
* Route53Stack
  * In ISNIC Manually redelegate nakom.is to the newly created Route53 NS records 
  * In Route53 Manually redelegate nakomis.com and nakomis.co.uk to the newly created Route53 NS records 
* CertificateStack
* CloudfrontStack
* Route53AdditionalStack