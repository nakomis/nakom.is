# DNS zone ownership

This document describes which Route53 hosted zones the nakomis projects use, which repository and
CDK stack owns each zone and each record, and how delegation between zones works. Every statement
below is taken from the CDK code in this repository (`nakomis/nakom.is`) and in
[`nakomis/nakomis-infra`](https://github.com/nakomis/nakomis-infra). Where the code does not say,
the document says so rather than guessing.

## To confirm with Martin

These points cannot be determined from the code in either repository:

1. **Who created the sandbox zones `sandbox.nakom.is` and `sandbox.nakomis.com`.** Both repositories
   only look them up (`fromLookup` / `fromHostedZoneAttributes`); neither creates them. They were
   presumably created by hand in the sandbox account (`975050268859`).
2. **How the sandbox zones are delegated.** No code in either repository writes NS records. The prod
   parent zones (`nakom.is`, `nakomis.com`) live in a different account (`637423226886`), so the
   delegation would need `sandbox` NS records in those parent zones. None appear in the prod
   `Route53Stack` (nor in the legacy record files in `route53/`), so if they exist they were added by
   hand outside CloudFormation.
3. **Who owns the `silverknoweseastway.com` and `silverknoweseastway.org` zones.** The prod
   `Route53Stack` looks them up but does not create them, and no code in either repository writes
   records into them (they are filtered out of `Route53AdditionalStack`).
4. **That `nakomis-infra`'s hard-coded zone IDs are the zones this repository creates/looks up.**
   `nakomis-infra` uses `Z019437529YGFB53BDUGR` for `nakomis.com` (prod) and
   `Z03586633NXU18LFL0JTL` for `sandbox.nakomis.com` (sandbox). The prod `nakomis.com` zone is
   created by this repository's `Route53Stack`, but the code cannot show that the IDs match.
5. **Where `blog.nakomis.com`, `app.nakomis.com` and `app.sandbox.nakomis.com` are defined.**
   CloudFront redirects `nakomis.com` to `blog.nakomis.com`, and `nakomis-infra`'s `FirmwareStack`
   lists the `app.` hosts as CORS origins, but neither repository writes their DNS records. The blog
   is described in `ChatStack` as a "separate CDK app".
6. **Who created the SES domain identities `nakomis.com` and `sandbox.nakomis.com`.** `nakomis-infra`'s
   `AuthStack` sets their MAIL FROM attributes and uses them for Cognito email, but does not create
   them.
7. **Whether the legacy ACM validation CNAMEs and test records are still needed.** `Route53Stack`
   imports `_8f4b….nakom.is`, `_5fed….nakomis.com`, `_ecf0….nakomis.co.uk` and
   `_8a23….homeasistant.nakomis.com` (note the spelling), plus `arecordtest.nakom.is` and
   `cnametest.nakomis.com`. Nothing in the code shows whether any current certificate depends on them.
8. **Whether `sandbox.nakomis.com`'s apex alias is intended.** In sandbox, `Route53AdditionalStack`
   points the `sandbox.nakomis.com` apex at the CloudFront distribution, but the sandbox
   distribution's `domainNames` (and certificate) only cover `sandbox.nakom.is` and
   `cv.sandbox.nakomis.com`, so CloudFront would not serve that host. `nakomis-infra`'s
   `FirmwareStack` also lists `https://sandbox.nakomis.com` as a CORS origin.
9. **Whether `www.nakomis.com` should be served.** The legacy `www.nakomis.com` CNAME points at
   `nakomis.com`, and the CloudFront function redirects `www.nakomis.com` to the blog, but
   `www.nakomis.com` is not in the distribution's `domainNames` or the certificate.

## Accounts and environments

Both repositories deploy into the same two AWS accounts, selected by `NPM_ENVIRONMENT`:

| Environment | Account        | Region (zones and most stacks) |
|-------------|----------------|--------------------------------|
| sandbox     | `975050268859` | `eu-west-2`                    |
| prod        | `637423226886` | `eu-west-2`                    |

Certificates used by CloudFront and Cognito are created in `us-east-1`; Route53 itself is global.

## Hosted zones

| Zone                      | Env     | Created by                                   | Referenced by                                                                 |
|---------------------------|---------|----------------------------------------------|-------------------------------------------------------------------------------|
| `nakom.is`                | prod    | nakom.is `Route53Stack` (`new HostedZone`)   | nakom.is `SESStack`, `CertificateStack`, `Route53AdditionalStack`             |
| `nakomis.com`             | prod    | nakom.is `Route53Stack` (`new HostedZone`)   | nakom.is `CertificateStack`, `CloudfrontStack` (lookup), `Route53AdditionalStack`; nakomis-infra `AuthCertStack`, `AuthStack` (by ID), `DeploymentTrackerStack` (lookup) |
| `nakomis.co.uk`           | prod    | nakom.is `Route53Stack` (`new HostedZone`)   | nakom.is `CertificateStack`, `Route53AdditionalStack`                         |
| `silverknoweseastway.com` | prod    | Not in code (lookup only)                    | nakom.is `Route53Stack` (lookup); passed to `CertificateStack` but not used by the certificate |
| `silverknoweseastway.org` | prod    | Not in code (lookup only)                    | As above                                                                      |
| `sandbox.nakom.is`        | sandbox | Not in code (lookup only)                    | nakom.is `Route53Stack` (lookup), `SESStack`, `CertificateStack`, `Route53AdditionalStack` |
| `sandbox.nakomis.com`     | sandbox | Not in code (lookup only)                    | nakom.is `Route53Stack` (lookup), `CertificateStack`, `CloudfrontStack` (lookup), `Route53AdditionalStack`; nakomis-infra `AuthCertStack`, `AuthStack` (by ID), `DeploymentTrackerStack` (lookup) |

`nakomis-infra` creates no hosted zones and writes no NS records; it only adds records to zones that
already exist.

The prod zones created by `Route53Stack` have no explicit removal policy, so the synthesised
templates carry no `DeletionPolicy` on them: deleting `Route53Stack` would delete the zones.

## Delegation

No NS records are written by either repository. Delegation is entirely manual:

- **Registrar to prod zones.** As the [README](../README.md#deployment-order) records, after
  `Route53Stack` creates the prod zones the name servers are set by hand: at ISNIC for `nakom.is`
  (a `.is` domain cannot be registered through Route53), and in Route53 Registered Domains for
  `nakomis.com` and `nakomis.co.uk`. `Route53Stack` deliberately skips the NS and SOA records in the
  legacy record files, so Route53's own apex NS/SOA records are left alone.
- **Prod zones to sandbox zones.** Not in code; see [To confirm](#to-confirm-with-martin) item 2.

To check or restore either level of delegation, follow the
[DNS zone restoration runbook](runbooks/dns-zone-restoration.md).

```
ISNIC (.is registry) ──NS──▶ nakom.is            (prod, nakom.is Route53Stack)
                                └─(not in code)─▶ sandbox.nakom.is     (sandbox, pre-existing)
Route53 Registered Domains ──NS──▶ nakomis.com   (prod, nakom.is Route53Stack)
                                └─(not in code)─▶ sandbox.nakomis.com  (sandbox, pre-existing)
Route53 Registered Domains ──NS──▶ nakomis.co.uk (prod, nakom.is Route53Stack)
```

## Records by stack

### nakom.is repository

| Stack                    | Region      | Env     | Records written                                                                                                    |
|--------------------------|-------------|---------|--------------------------------------------------------------------------------------------------------------------|
| `Route53Stack`           | `eu-west-2` | prod    | Legacy records from `route53/*.json`: every non-alias `A`, `CNAME`, `MX` and `TXT` record (NS, SOA and alias `A` records are skipped). Includes the Google Workspace `MX` records on all three apexes, Google site-verification `TXT` records, the `google._domainkey.nakomis.com` DKIM `TXT`, `calendar`/`drive`/`mail` CNAMEs to `ghs.googlehosted.com`, `www.nakomis.com`, `homeassistant.nakomis.com`, and old ACM validation CNAMEs. |
| `Route53Stack`           | `eu-west-2` | sandbox | None (the sandbox zones have no legacy records).                                                                   |
| `SESStack`               | `eu-west-2` | both    | In the `nakom.is` / `sandbox.nakom.is` zone: three SES DKIM `CNAME`s, plus `MX` and SPF `TXT` for the MAIL FROM domain `mail.nakom.is` / `mail.sandbox.nakom.is`. These are owned by `SESStack`, not `Route53Stack`. |
| `CertificateStack`       | `us-east-1` | both    | ACM DNS-validation `CNAME`s, written by CloudFormation through the certificate's `DomainValidationOptions` (they are not template resources). Prod certificate: `nakom.is` + `nakomis.com`, `nakomis.co.uk`, `cv.nakomis.com` (validated in the `nakomis.com` zone). Sandbox: `sandbox.nakom.is` + `cv.sandbox.nakomis.com` (validated in `sandbox.nakomis.com`). |
| `CloudfrontStack`        | `eu-west-2` | both    | `A` alias `cv.nakomis.com` (prod) / `cv.sandbox.nakomis.com` (sandbox) to the distribution. The zone is found with `fromLookup`, not passed in from `Route53Stack`. |
| `Route53AdditionalStack` | `eu-west-2` | both    | Apex `A` and `AAAA` aliases to the CloudFront distribution in every zone from `Route53Stack` except the `silverknoweseastway` ones: `nakom.is`, `nakomis.com`, `nakomis.co.uk` (prod); `sandbox.nakom.is`, `sandbox.nakomis.com` (sandbox). |

### nakomis-infra repository

| Stack                    | Region      | Records written (in `nakomis.com` for prod, `sandbox.nakomis.com` for sandbox)                                    |
|--------------------------|-------------|-------------------------------------------------------------------------------------------------------------------|
| `AuthCertStack`          | `us-east-1` | ACM DNS-validation `CNAME` for `login.<zone>`.                                                                    |
| `AuthStack`              | `eu-west-2` | `A` and `AAAA` aliases `login.<zone>` to the Cognito user pool domain; `MX` and SPF `TXT` for the SES MAIL FROM domain `bounce.<zone>`. |
| `DeploymentTrackerStack` | `eu-west-2` | ACM DNS-validation `CNAME` for `api.infra.<zone>` (regional certificate); `A` and `AAAA` aliases `api.infra.<zone>` to the API Gateway custom domain. |

`AuthCertStack` and `AuthStack` reference the zone by a hard-coded hosted zone ID;
`DeploymentTrackerStack` uses `fromLookup` by name.

## Rule for adding a new record

1. **Write it in CDK, in the stack that owns the thing the record points at.** The pattern in both
   repositories is that the record lives beside its target: CloudFront aliases in the CloudFront
   stacks, SES records in the SES/auth stacks, a service's custom-domain alias in that service's stack.
   Do not create records by hand in the console: a hand-made record that collides with one CDK later
   creates will fail the deploy, and nothing tracks it.
2. **Reference the zone; never create a second one.** Zones are created only by nakom.is
   `Route53Stack` (prod) or exist already (sandbox, `silverknoweseastway`). Other stacks and
   repositories import them with `fromLookup` or `fromHostedZoneAttributes`.
3. **Use a name nobody else writes.** Each name/type pair may be owned by one stack only. Names already
   taken are listed in the tables above; in `nakomis.com` / `sandbox.nakomis.com` in particular,
   both repositories write records, so check both.
4. **Static third-party records** (mail, site verification, Google services) for the three prod zones
   go in the matching `route53/<zone>.json` file, which `Route53Stack` imports. Only `A` (non-alias),
   `CNAME`, `MX` and `TXT` types are handled; anything else is logged and skipped.
5. **Cover both environments.** Derive the name from `deployEnv` (see `domain()` in
   `lib/deploy-env.ts`, or the `HOSTED_ZONES` / `ZONE_NAMES` maps in nakomis-infra) so the sandbox
   variant lands in the sandbox zone.
6. **Delegating a new subzone** (for example a further sandbox zone) is not automated: create the zone,
   then add its NS records to the parent by hand, and record the delegation in this document.
