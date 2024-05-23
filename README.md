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

In addition, I had several existing records for MX records and various other projects. I wanted to maintain these records, so I wrote the [utils/getroute53.is](utils/getroute53.is) script to download the records to [JSON files](https://github.com/nakomis/nakom.is/tree/main/route53). The Route53 stack then [parses](lib/route53-stack.ts#L39-L89) these records and adds them to the new hosted zone.

### Cloudfront

The [Cloudfront](lib/cloudfront-stack.ts) stack creates a Cloudfront CDN with a single origin for the API Gateway. The CDN's primary responsibility is redirecting HTTP requests to HTTPS, which is not supported by API Gateway (for good reason). A CDN is probably overkill for this, but it's trivial to set up and [virtually free](https://aws.amazon.com/cloudfront/pricing/) for my use-case.

The CDN also acts as the SSL termination point, with a certificate installed covering the three domain names used for the site. In addition it adds the API Key to all inbound requests, which is used by the API Gateway usage plan.

### Certificate Manager

The [Certificate](lib/certificate-stack.ts) stack creates a server certificate for the CDN,
covering the three domain names in use. DSN validation is used to automatically validate the certificate by creating the validation records in the Route53 hosted zones.

As AWS Certificates are global, the certificate must be created in the us-east-1 region,
whereas the other stacks are created in eu-west-2. This is handled by the environment passed
to the stack constructor in the [App](bin/nakom.is.ts).

### API Gateway (nakom.is)

The [API Gateway](lib/apigateway-stack.ts) stack creates a REST API Gateway, which forwards
requests to a Lambda function, which in turn returns the appropriate redirect. In addition, certain exceptions are created for vanity URLs such as https://nakom.is/cv and https://nakom.is/wordle which return contents from a private S3 bucket without a redirect. The exception mechanism is also useful for returning *robots.txt* and *favicon.ico* files without a redirect.

I've also setup a */static/filename.xyz* path, which returns files from the S3 bucket without over-crowding the root path with exceptions. It's mostly used by the [wordle](s3contents/wordle.html) page for the images. If the S3 integration returns a *404*, indicating that the file does not exist in the bucket, then the API Gateway will return a *301* redirect to Google with the filename as a search parameter.

### Lambda function & DynamodDb

The [Lambda](lib/lambda-stack.ts) stack creates the Lambda function which is the heart of the redirection, along with a DynamoDB database used to store the redirects. 

The lambda is a simple [python script](lambda/urlshortener.py) which extracts the desired short URL from the path, looks up the record in a DynamoDB database and constructs the appropriate *301* redirect.

If the short path is not found, the lambda redirects the user to Google with the short URL as a query. If the short path is found in the database, a simple hit counter is incremented, and the value written back to the database before returning the redirect. A race condition exists where a second user can read the value from the database before the first has been written back, but given the use-case I decided not to bother with conditional writes.

There's also an exception for short URLs beginning with the literal *cat*, which redirects to a [HTTP Status Code lookup page](https://http.cat), e.g. https://nakom.is/cat418 will redirect to https://http.cat/status/418


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