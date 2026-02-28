# Silverknowes Eastway Domain Redirect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redirect silverknoweseastway.com and silverknoweseastway.org to nakom.is using CloudFront

**Architecture:** Extend existing CloudFront distribution to serve new domains with CloudFront Function returning 301 redirects to nakom.is

**Tech Stack:** AWS CDK, CloudFront Functions (JS), Route53, ACM Certificate Manager

---

## Task 1: Import Existing Route53 Hosted Zones

**Files:**
- Modify: `lib/route53-stack.ts:35-39`

**Step 1: Add hosted zone imports after existing zones**

Add these lines after line 34 (after nakomisCoUkHostedZone creation):

```typescript
        const silverknowesEastwayComHostedZone = route53.HostedZone.fromLookup(this, 'SilverknowesEastwayComHostedZone', {
            domainName: 'silverknoweseastway.com',
        });
        const silverknowesEastwayOrgHostedZone = route53.HostedZone.fromLookup(this, 'SilverknowesEastwayOrgHostedZone', {
            domainName: 'silverknoweseastway.org',
        });
```

**Step 2: Add imported zones to hostedZones array**

Add these lines after line 38 (after the existing push statements):

```typescript
        this.hostedZones.push({zoneName: silverknowesEastwayComHostedZone.zoneName, zone: silverknowesEastwayComHostedZone, legacyRecords: {ResourceRecordSets: []}});
        this.hostedZones.push({zoneName: silverknowesEastwayOrgHostedZone.zoneName, zone: silverknowesEastwayOrgHostedZone, legacyRecords: {ResourceRecordSets: []}});
```

**Step 3: Test CDK synthesis**

```bash
cd /Users/martinmu_1/repos/nakomis/nakom.is
cdk synth Route53Stack
```

Expected: No errors, zones should be looked up successfully

**Step 4: Commit changes**

```bash
git add lib/route53-stack.ts
git commit -m "feat: import silverknoweseastway hosted zones for redirect setup"
```

## Task 2: Update Certificate with New Domains

**Files:**
- Modify: `lib/certificate-stack.ts:27`

**Step 1: Add new domains to certificate subjectAlternativeNames**

Replace line 27:
```typescript
            subjectAlternativeNames: ['nakomis.com', 'nakomis.co.uk'],
```

With:
```typescript
            subjectAlternativeNames: ['nakomis.com', 'nakomis.co.uk', 'silverknoweseastway.com', 'silverknoweseastway.org'],
```

**Step 2: Test certificate stack synthesis**

```bash
cdk synth CertificateStack
```

Expected: No errors, certificate should include all 4 domains in SAN

**Step 3: Commit certificate changes**

```bash
git add lib/certificate-stack.ts
git commit -m "feat: add silverknoweseastway domains to SSL certificate"
```

## Task 3: Create CloudFront Redirect Function

**Files:**
- Modify: `lib/cloudfront-stack.ts:111`
- Modify: `lib/cloudfront-stack.ts:50-110`

**Step 1: Add new domains to CloudFront distribution**

Replace line 111:
```typescript
            domainNames: ['nakom.is', 'nakomis.com', 'nakomis.co.uk'],
```

With:
```typescript
            domainNames: ['nakom.is', 'nakomis.com', 'nakomis.co.uk', 'silverknoweseastway.com', 'silverknoweseastway.org'],
```

**Step 2: Create redirect CloudFront Function**

Add after line 49 (after the socialRedirectFunction):

```typescript
        // Redirect silverknoweseastway domains to nakom.is
        const silverknowesRedirectFunction = new cloudfront.Function(this, 'SilverknowesRedirectFunction', {
            functionName: 'nakomis-silverknowes-redirect',
            code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
    var request = event.request;
    var host = request.headers.host.value;

    // Redirect silverknoweseastway domains to nakom.is
    if (host === 'silverknoweseastway.com' || host === 'silverknoweseastway.org') {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: {
                location: { value: 'https://nakom.is/' }
            }
        };
    }

    // Continue normal processing for other domains
    return request;
}
`),
            runtime: cloudfront.FunctionRuntime.JS_2_0,
        });
```

**Step 3: Update function associations in default behavior**

Replace the functionAssociations array in the defaultBehavior (around line 105):

```typescript
                functionAssociations: [
                    {
                        function: socialRedirectFunction,
                        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                    },
                    {
                        function: silverknowesRedirectFunction,
                        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                    }
                ],
```

**Step 4: Test CloudFront stack synthesis**

```bash
cdk synth CloudfrontStack
```

Expected: No errors, should show both functions and all 5 domains

**Step 5: Commit CloudFront changes**

```bash
git add lib/cloudfront-stack.ts
git commit -m "feat: add silverknowes redirect function and domains to CloudFront"
```

## Task 4: Add AAAA Records to Route53 Additional Stack

**Files:**
- Modify: `lib/route53-additional-stack.ts:18-24`

**Step 1: Add AAAA record creation alongside existing A record**

Replace the forEach loop content (lines 18-24) with:

```typescript
        props?.hostedZones.forEach(zone => {
            // Create the A Alias record, pointing to the CDN
            new route53.ARecord(this, `${zone.zoneName}AApiGateway`, {
                recordName: zone.zoneName,
                zone: zone.zone,
                target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(props!.cloudfront))
            });

            // Create the AAAA Alias record for IPv6, pointing to the CDN
            new route53.AaaaRecord(this, `${zone.zoneName}AAAAApiGateway`, {
                recordName: zone.zoneName,
                zone: zone.zone,
                target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(props!.cloudfront))
            });
        });
```

**Step 2: Test Route53 additional stack synthesis**

```bash
cdk synth Route53AdditionalStack
```

Expected: No errors, should show both A and AAAA records for all 5 domains

**Step 3: Commit Route53 additional changes**

```bash
git add lib/route53-additional-stack.ts
git commit -m "feat: add IPv6 (AAAA) records alongside IPv4 (A) records for all domains"
```

## Task 5: Deploy Certificate Stack (US East 1)

**Files:**
- N/A (deployment task)

**Step 1: Deploy certificate stack to us-east-1**

```bash
AWS_PROFILE=nakom.is-admin cdk deploy CertificateStack
```

Expected: SUCCESS - Certificate updated with new domains, DNS validation successful

**Step 2: Verify certificate includes new domains**

Check AWS Console or:
```bash
AWS_PROFILE=nakom.is-admin aws acm describe-certificate --certificate-arn $(cdk output CertificateStack.CertificateArn) --region us-east-1
```

Expected: SubjectAlternativeNames includes silverknoweseastway.com and silverknoweseastway.org

## Task 6: Deploy CloudFront and Route53 Stacks (EU West 2)

**Files:**
- N/A (deployment task)

**Step 1: Deploy CloudFront stack**

```bash
AWS_PROFILE=nakom.is-admin cdk deploy CloudfrontStack
```

Expected: SUCCESS - Distribution updated with new domains and redirect function

**Step 2: Deploy Route53 additional stack**

```bash
AWS_PROFILE=nakom.is-admin cdk deploy Route53AdditionalStack
```

Expected: SUCCESS - A and AAAA records created for new domains

## Task 7: Test Redirect Functionality

**Files:**
- N/A (testing task)

**Step 1: Wait for CloudFront propagation**

Wait 15-30 minutes for CloudFront global propagation.

**Step 2: Test HTTP redirect from silverknoweseastway.com**

```bash
curl -I https://silverknoweseastway.com/
```

Expected:
```
HTTP/2 301
location: https://nakom.is/
```

**Step 3: Test HTTP redirect from silverknoweseastway.org**

```bash
curl -I https://silverknoweseastway.org/
```

Expected:
```
HTTP/2 301
location: https://nakom.is/
```

**Step 4: Test redirect with path preservation ignored**

```bash
curl -I https://silverknoweseastway.com/some/path
```

Expected:
```
HTTP/2 301
location: https://nakom.is/
```

**Step 5: Test existing domains still work**

```bash
curl -I https://nakom.is/
curl -I https://nakomis.com/
curl -I https://nakomis.co.uk/
```

Expected: All return HTTP 200 or appropriate responses (not 301)

## Task 8: Verify IPv6 Connectivity (Optional)

**Files:**
- N/A (testing task)

**Step 1: Check AAAA record resolution**

```bash
dig AAAA silverknoweseastway.com
dig AAAA silverknoweseastway.org
```

Expected: Returns CloudFront IPv6 addresses

**Step 2: Test IPv6 redirect (if available)**

```bash
curl -6 -I https://silverknoweseastway.com/
```

Expected: HTTP/2 301 redirect to nakom.is (if IPv6 available)

## Task 9: Final Commit and Documentation

**Files:**
- Modify: `CLAUDE.md` (add note about new domains)

**Step 1: Update project documentation**

Add to CLAUDE.md under "Architecture overview":

```markdown
- Five domains: nakom.is, nakomis.com, nakomis.co.uk, silverknoweseastway.com, silverknoweseastway.org (last two redirect to nakom.is via CloudFront Function)
```

**Step 2: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs: update architecture notes with silverknowes redirect domains"
```

**Step 3: Create summary commit**

```bash
git log --oneline -n 6
```

Expected: Shows 6 commits for the complete redirect implementation

---

## Success Criteria

- ✅ Both silverknoweseastway domains return 301 redirects to https://nakom.is/
- ✅ HTTPS certificates valid for both domains
- ✅ IPv4 and IPv6 DNS records resolve to CloudFront
- ✅ Existing domain functionality unchanged
- ✅ Redirect works regardless of original path
- ✅ All deployments successful in correct regions