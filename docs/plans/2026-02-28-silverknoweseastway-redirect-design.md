# Silverknowes Eastway Domain Redirect Design

**Date**: 2026-02-28
**Status**: Approved
**Domains**: silverknoweseastway.com, silverknoweseastway.org → nakom.is

## Overview

Add redirect functionality for two new domains (silverknoweseastway.com and silverknoweseastway.org) to redirect all traffic to nakom.is using the existing CloudFront infrastructure.

## Requirements

- **Redirect Type**: 301 permanent redirect
- **Destination**: All traffic redirects to `https://nakom.is/` (homepage)
- **Path Handling**: Ignore original paths, always redirect to root
- **Protocol**: HTTPS support required
- **IPv6**: Support both IPv4 (A records) and IPv6 (AAAA records)

## Architecture

### Approach: CloudFront Redirect Extension

Extend the existing CloudFront distribution to serve the new domains and handle redirects via CloudFront Functions.

**Benefits**:
- Minimal infrastructure changes
- Cost-effective (reuses existing distribution)
- Consistent with current architecture
- No additional certificates or origins required

### Components

#### 1. Certificate Stack Updates
- **File**: `lib/certificate-stack.ts`
- **Changes**: Add new domains to `subjectAlternativeNames`
- **Current**: `['nakomis.com', 'nakomis.co.uk']`
- **New**: `['nakomis.com', 'nakomis.co.uk', 'silverknoweseastway.com', 'silverknoweseastway.org']`

#### 2. Route53 Stack Updates
- **File**: `lib/route53-stack.ts`
- **Changes**: Import existing hosted zones for new domains
- **Method**: Use `HostedZone.fromLookup()` to reference existing zones created during domain registration
- **Validation**: Add imported zones to hostedZones array for certificate DNS validation

#### 3. CloudFront Stack Updates
- **File**: `lib/cloudfront-stack.ts`
- **Changes**:
  - Add domains to `domainNames` array
  - Create new CloudFront Function for redirect logic
  - Attach function to viewer-request event

#### 4. Route53 Additional Stack Updates
- **File**: `lib/route53-additional-stack.ts`
- **Changes**: Add AAAA record creation alongside existing A records
- **Automatic**: Existing forEach loop will handle new domains once they're in hostedZones array

## Implementation Details

### CloudFront Redirect Function

```javascript
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
```

### DNS Records
Both A and AAAA records will be created pointing to the CloudFront distribution:
- `silverknoweseastway.com` → CloudFront distribution (A + AAAA)
- `silverknoweseastway.org` → CloudFront distribution (A + AAAA)

## Data Flow

1. User visits `silverknoweseastway.com/anything`
2. DNS resolves to CloudFront edge location (A/AAAA records)
3. CloudFront Function inspects host header
4. Returns 301 redirect to `https://nakom.is/`
5. Browser follows redirect to nakom.is

## Error Handling

- **Function Failure**: Request continues to origin (graceful degradation)
- **Certificate Validation**: CDK deployment fails fast if validation fails
- **DNS Propagation**: Temporary resolution delays expected (up to 48 hours)
- **No Impact**: Existing domains continue to work normally

## Deployment Considerations

### Deploy Order
1. **CertificateStack** (us-east-1) - Add domains to certificate
2. **Route53Stack** (eu-west-2) - Import hosted zones
3. **CloudfrontStack** (eu-west-2) - Add domains and redirect function
4. **Route53AdditionalStack** (eu-west-2) - Create A/AAAA records

### Expected Timeline
- **CDK Deployment**: ~10-15 minutes
- **Certificate Validation**: ~2-5 minutes (DNS validation)
- **CloudFront Propagation**: ~15-30 minutes
- **DNS Propagation**: Up to 48 hours globally

### Testing
- Verify redirect behaviour: `curl -I https://silverknoweseastway.com/any/path`
- Expected: `HTTP/2 301` with `Location: https://nakom.is/`
- Test both domains and various paths
- Verify IPv6 connectivity if available

## Risk Assessment

**Low Risk**:
- Extends existing proven architecture
- No changes to current domain behaviour
- Graceful degradation if redirect function fails
- Rollback possible by removing domains from distribution

**Considerations**:
- DNS propagation delay for new domains
- Brief CloudFront cache invalidation during deployment
- Certificate validation requires zones to be properly configured

## Success Criteria

- ✅ Both domains redirect to nakom.is with 301 status
- ✅ HTTPS works correctly with valid certificate
- ✅ IPv4 and IPv6 connectivity functional
- ✅ No impact on existing domain functionality
- ✅ Redirect behaviour consistent regardless of original path