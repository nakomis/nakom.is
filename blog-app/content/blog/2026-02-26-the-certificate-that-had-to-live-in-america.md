---
title: "The Certificate That Had to Live in America"
date: "2026-02-26"
excerpt: "I'd done AWS infrastructure the old-fashioned way for years. When it came time to rebuild nakom.is properly with CDK, one decision cost me several evenings of caffeinated Googling."
tags: ["aws", "cdk", "cloudfront", "certificates"]
author: "Martin Harris"
canonical: "https://blog.nakom.is/the-certificate-that-had-to-live-in-america"
---

# The Certificate That Had to Live in America

I'd done AWS infrastructure the old-fashioned way for years. Click into the console, find the right service, fill in the boxes, wonder why the boxes are laid out like that, click create. It works, in the same way that writing code in Notepad works. So when it came time to rebuild [nakom.is](https://nakom.is) properly, I decided to do it with CDK. Infrastructure as code. No more box-clicking.

That decision cost me several evenings of increasingly caffeinated Googling. But it taught me more about how AWS actually works than years of console-clicking ever had. This is the story of one of those evenings — the one about certificates.

## Three domains, one CloudFront distribution

nakom.is runs on three domains: `nakom.is`, `nakomis.com`, and `nakomis.co.uk`. They all point to the same CloudFront distribution, which sits in front of an API Gateway in eu-west-2 (London). One distribution, three domains, one certificate that covers all three.

The certificate bit is where the fun starts.

## The stack split

First, a word on multi-stack CDK. When you're building non-trivial infrastructure, you have a choice: one enormous stack with everything in it, or multiple focused stacks. I went with the latter — not for any grand architectural reason, but because a 400-line file is hard to navigate and a 60-line file isn't. The CDK `App` at the root wires everything together and passes outputs from one stack to the next:

```typescript
const r53Stack = new Route53Stack(app, 'Route53Stack', londonEnv);

const certificateStack = new CertificateStack(app, 'CertificateStack', {
    ...nvirginiaEnv,
    hostedZones: r53Stack.hostedZones  // passed from Route53Stack
});

const cloudfrontStack = new CloudfrontStack(app, 'CloudfrontStack', {
    ...londonEnv,
    certificate: certificateStack.certificate,  // passed from CertificateStack
    // ...
});
```

Clean enough. The problem is those two environment variables: `londonEnv` (eu-west-2) and `nvirginiaEnv` (us-east-1). Most of the stack is in London. The certificate is in Virginia. Why?

## The us-east-1 problem

CloudFront is a global service, but its TLS certificates must be stored in ACM (AWS Certificate Manager) in `us-east-1`. Not your region. Not a region of your choice. Specifically us-east-1, because that's where CloudFront reads them from. This is not a CDK limitation — it's an AWS constraint that applies regardless of how you deploy.

When I first tried creating the certificate in eu-west-2 (where everything else lives), CDK deployed it just fine. CloudFront then firmly declined to use it.

The obvious fix — just create the CertificateStack with `nvirginiaEnv` — immediately creates a new problem. The certificate stack needs the Route53 hosted zones (which are in eu-west-2) to perform DNS validation. Passing a eu-west-2 resource into a us-east-1 stack isn't something CDK allows by default. Stacks in different regions don't share state.

*There has to be a solution*, I thought. *Somebody else must have hit this.*

## One property

After enough Googling, I found it: `crossRegionReferences`.

```typescript
const r53Stack = new Route53Stack(app, 'Route53Stack', {
    ...londonEnv,
    crossRegionReferences: true  // 👈
});

const certificateStack = new CertificateStack(app, 'CertificateStack', {
    ...nvirginiaEnv,
    crossRegionReferences: true  // 👈
    hostedZones: r53Stack.hostedZones
});

const cloudfrontStack = new CloudfrontStack(app, 'CloudfrontStack', {
    ...londonEnv,
    crossRegionReferences: true  // 👈
    certificate: certificateStack.certificate,
    // ...
});
```

Set it on any stack that either produces or consumes a cross-region reference, and CDK handles the rest. The certificate ARN flows from us-east-1 into eu-west-2; the hosted zone IDs flow from eu-west-2 into us-east-1. It just works.

What it does under the hood is worth understanding, because the generated CloudFormation looks alarming at first glance. CDK uses SSM Parameter Store as a cross-region relay: the value is written to an SSM parameter in the *source* region by a custom CloudFormation resource, and then read from SSM in the *target* region by another custom resource. Each of those custom resources is backed by a small Lambda function that CDK generates and deploys automatically. You'll see stacks with names like `CertificateStack-support-us-east-1` that you didn't write — those are the relay infrastructure. They're not a mistake; they're the mechanism.

## Three hosted zones, one certificate

The next wall was DNS validation. ACM validates certificate requests by having you add a CNAME record to each domain's DNS. With three domains across three hosted zones, you need to tell CDK which hosted zone owns which domain.

The naive approach — three separate `Certificate` constructs, one per domain — works but leaves you with three certificates to manage. The right answer is one certificate with Subject Alternative Names (SANs):

```typescript
this.certificate = new cm.Certificate(this, "NakomIsCert", {
    domainName: 'nakom.is',
    subjectAlternativeNames: ['nakomis.com', 'nakomis.co.uk'],
    validation: cm.CertificateValidation.fromDnsMultiZone({
        'nakom.is':      nakomIsHostedZone,
        'nakomis.com':   nakomisComHostedZone,
        'nakomis.co.uk': nakomisCoUkHostedZone,
    })
});
```

`CertificateValidation.fromDnsMultiZone` takes a map of domain → hosted zone and handles adding the validation CNAME records to each zone automatically. Without it, CDK doesn't know which zone to add the validation record to and the deployment hangs waiting for a DNS record that never appears.

## The Icelandic wrinkle

`.is` domains — Iceland's country code TLD — can't be registered through AWS. AWS Route53 supports a long list of TLDs, but `.is` isn't on it. You have to register with an Icelandic registrar.

This would normally mean you can't use Route53 for DNS. But you can, because DNS delegation is independent of domain registration. The trick:

1. Create a Route53 hosted zone for `nakom.is` as normal. Route53 assigns it four nameserver addresses.
2. At your Icelandic registrar, set the domain's nameservers to those four Route53 addresses.
3. Route53 now answers DNS queries for `nakom.is`. The registrar just holds the registration and the delegation.

One small gotcha: when Route53 creates a hosted zone, it generates NS and SOA records automatically. Your Icelandic registrar also has SOA records for the domain. These two SOA records will not match, and that's fine — once delegation is set up, nobody ever queries the registrar's SOA. Only the Route53 records are ever served. In the CDK code, when importing legacy DNS records from the registrar export, NS and SOA are explicitly skipped:

```typescript
case 'NS':
case 'SOA':
    break;  // Route53 manages these; don't import the legacy ones
```

With delegation in place, ACM's DNS validation works exactly the same as it would for a `.com` — it's just Route53 records being written and queried, regardless of who holds the registration.

## The resulting architecture

The final `bin/nakom.is.ts` shows the whole picture clearly:

```typescript
const londonEnv   = { env: { account: '...', region: 'eu-west-2' } };
const nvirginiaEnv = { env: { account: '...', region: 'us-east-1' } };

const r53Stack = new Route53Stack(app, 'Route53Stack', {
    ...londonEnv,
    crossRegionReferences: true
});

const certificateStack = new CertificateStack(app, 'CertificateStack', {
    ...nvirginiaEnv,
    crossRegionReferences: true,
    hostedZones: r53Stack.hostedZones
});

const cloudfrontStack = new CloudfrontStack(app, 'CloudfrontStack', {
    ...londonEnv,
    certificate: certificateStack.certificate,
    crossRegionReferences: true,
    // ...
});
```

Three `crossRegionReferences: true` lines. One `fromDnsMultiZone`. A manual NS delegation at an Icelandic registrar. And a certificate that, for reasons entirely outside your control, has to live in America.

---

*Martin Mu writes about connecting real hardware to abstract cloud infrastructure. If you've ever soldered something to an API Gateway, you're in the right place.*
