# Runbook: restoring DNS delegation after a hosted zone incident

Use this when `nakom.is`, `nakomis.com`, `nakomis.co.uk` or one of the sandbox subzones stops
resolving (or resolves to stale records) because the name servers the parent delegates to are not
the name servers of the hosted zone that actually holds the records. Zone ownership, accounts and
the delegation chain are described in [`docs/dns-zones.md`](../dns-zones.md); read its
[Delegation](../dns-zones.md#delegation) section first if you are unfamiliar with the setup.

The most likely cause is the prod `Route53Stack` replacing a zone. Its zones have no
`DeletionPolicy`, so deleting and redeploying the stack (or any change that forces replacement)
creates a new zone with a **new set of four name servers**. The registrar (ISNIC or Route53
Registered Domains) still points at the old ones, which either no longer answer (`SERVFAIL` /
`REFUSED`) or belong to an orphaned old zone that answers with stale data.

Delegation can break at two levels, and this runbook covers them in that order:

1. Registrar → prod zone (`nakom.is`, `nakomis.com`, `nakomis.co.uk`).
2. Prod zone → sandbox subzone (`sandbox.nakom.is`, `sandbox.nakomis.com`).

## April 2026 incident

> **TODO (Martin):** record what happened in April 2026: which zone(s) were affected, what broke
> the delegation, how it was noticed, how long resolution was broken, and what was done to fix it.
> Add anything the steps below got wrong or left out.

## Before you start

- AWS profiles: `nakom.is-admin` for prod (account `637423226886`), `nakom.is-sandbox` for sandbox
  (account `975050268859`).
- `dig` and `whois` installed locally.
- For `nakom.is`: a login to the [ISNIC portal](https://www.isnic.is/en). There is no API; that
  step is manual.
- Set the zone you are working on, so the commands below can be pasted as they are:

```bash
ZONE=nakom.is          # or nakomis.com, nakomis.co.uk
```

## 1. Confirm the symptom

```bash
# Follow delegation from the root. The last NS set printed before the answer is what the
# parent delegates to; an error at that step means those servers do not serve the zone.
dig +trace NS "$ZONE"

# Ask a public resolver; SERVFAIL here and a good answer in step 2 means delegation, not data.
dig @1.1.1.1 "$ZONE" A
dig @8.8.8.8 "$ZONE" SOA
```

## 2. Identify the authoritative zone

There may be more than one hosted zone with the same name (an orphaned old zone and the new one).
The authoritative zone is the one the current `Route53Stack` owns: it holds the records CDK manages,
and the other stacks (`SESStack`, `CertificateStack`, `CloudfrontStack`, `Route53AdditionalStack`)
write into it.

```bash
# Every zone with this name, with its ID and record count.
AWS_PROFILE=nakom.is-admin aws route53 list-hosted-zones-by-name \
  --dns-name "$ZONE" \
  --query "HostedZones[?Name=='$ZONE.'].[Id,ResourceRecordSetCount,Config.Comment]" \
  --output table

# The zone ID the stack owns (logical IDs NakomIsHostedZone*, NakomisComHostedZone*,
# NakomisCoUkHostedZone*).
AWS_PROFILE=nakom.is-admin aws cloudformation describe-stack-resources \
  --stack-name Route53Stack --region eu-west-2 \
  --query "StackResources[?ResourceType=='AWS::Route53::HostedZone'].[LogicalResourceId,PhysicalResourceId]" \
  --output table
```

Set `ZONE_ID` to the stack's zone (without the `/hostedzone/` prefix) and list the name servers
Route53 assigned to it:

```bash
ZONE_ID=Z0123456789ABCDEFGHIJ

AWS_PROFILE=nakom.is-admin aws route53 get-hosted-zone --id "$ZONE_ID" \
  --query 'DelegationSet.NameServers' --output text
```

Check that these servers really answer for the zone and hold the expected records:

```bash
NS1=$(AWS_PROFILE=nakom.is-admin aws route53 get-hosted-zone --id "$ZONE_ID" \
  --query 'DelegationSet.NameServers[0]' --output text)

dig @"$NS1" "$ZONE" SOA +norec    # expect an answer with the aa flag set
dig @"$NS1" "$ZONE" A +norec      # expect the CloudFront alias addresses
dig @"$NS1" "$ZONE" MX +norec     # expect the Google Workspace MX records
```

If another zone with the same name exists, **do not delete it yet**: resolvers that cached the old
delegation still query it until the parent's NS TTL expires (see step 5).

## 3. Check the delegation in the parent

Compare what the registry delegates to with the list from step 2. Ask the TLD servers directly, so
no resolver cache gets in the way:

```bash
# nakom.is (.is registry)
dig NS nakom.is @a.nic.is +norec

# nakomis.com (.com registry)
dig NS nakomis.com @a.gtld-servers.net +norec

# nakomis.co.uk (.uk registry)
dig NS nakomis.co.uk @dns1.nic.uk +norec
```

The NS records are in the AUTHORITY section. The registrar's own view:

```bash
whois nakom.is | grep -i nserver

AWS_PROFILE=nakom.is-admin aws route53domains get-domain-detail \
  --domain-name nakomis.com --region us-east-1 \
  --query 'Nameservers[].Name' --output text
```

If the parent's set and the zone's set from step 2 are the same, delegation is fine: the fault is
elsewhere (records missing from the zone, CloudFront, certificate). Otherwise restore it.

## 4. Restore the delegation

Use all four name servers from step 2, exactly as Route53 lists them.

### nakomis.com and nakomis.co.uk (Route53 Registered Domains)

The domains are registered in the prod account; the Route53 Domains API only exists in `us-east-1`.

```bash
read -r NS1 NS2 NS3 NS4 < <(AWS_PROFILE=nakom.is-admin aws route53 get-hosted-zone \
  --id "$ZONE_ID" --query 'DelegationSet.NameServers' --output text)

AWS_PROFILE=nakom.is-admin aws route53domains update-domain-nameservers \
  --region us-east-1 \
  --domain-name "$ZONE" \
  --nameservers Name="$NS1" Name="$NS2" Name="$NS3" Name="$NS4"
```

This returns an `OperationId`. Follow it until it reports `SUCCESSFUL`:

```bash
AWS_PROFILE=nakom.is-admin aws route53domains get-operation-detail \
  --region us-east-1 --operation-id <OperationId>
```

### nakom.is (ISNIC) — manual

1. Print the four name servers: `echo "$NS1 $NS2 $NS3 $NS4"` (after the `read` above).
2. Log in to the [ISNIC portal](https://www.isnic.is/en) and open the `nakom.is` domain.
3. Replace the existing name servers with the four Route53 ones and submit.
4. ISNIC tests the new name servers before accepting the change: they must already answer
   authoritatively for `nakom.is` (step 2 checks this). If ISNIC rejects the change, its error
   message names the failing test; fix the zone and resubmit.

## 5. Verify resolution

```bash
# The registry now delegates to the new set.
dig NS "$ZONE" @a.nic.is +norec            # or a.gtld-servers.net / dns1.nic.uk

# Full chain from the root.
dig +trace "$ZONE" A

# Public resolvers (may lag; see below).
dig @1.1.1.1 "$ZONE" A
dig @8.8.8.8 "$ZONE" NS

# End to end.
curl -sI "https://$ZONE/" | head -1
```

Resolvers that cached the old delegation keep using it until the TTL on the parent's NS records
runs out (shown in the second column of the `dig NS ... @<tld server>` output; up to 48 hours for
`.com`). Only once that has passed, and nothing still queries the old zone, delete the orphaned
zone (after checking it has no records you still need).

Then run the smoke test: `npm run smoke`.

## 6. Sandbox subzones

`sandbox.nakom.is` and `sandbox.nakomis.com` are hosted in the sandbox account. They are delegated
by a `sandbox` NS record in the prod parent zone, which was added by hand and is **not in any CDK
code**. It is lost if the parent zone is recreated, and it goes stale if a sandbox zone is
recreated. Do this section after the prod zones resolve again.

```bash
SUB=sandbox.nakom.is     # or sandbox.nakomis.com
PARENT=nakom.is          # or nakomis.com
```

Find the sandbox zone and its name servers:

```bash
AWS_PROFILE=nakom.is-sandbox aws route53 list-hosted-zones-by-name \
  --dns-name "$SUB" \
  --query "HostedZones[?Name=='$SUB.'].[Id,ResourceRecordSetCount]" --output table

SUB_ZONE_ID=Z0123456789ABCDEFGHIJ

AWS_PROFILE=nakom.is-sandbox aws route53 get-hosted-zone --id "$SUB_ZONE_ID" \
  --query 'DelegationSet.NameServers' --output text
```

Check what the prod parent delegates to:

```bash
PARENT_ZONE_ID=$(AWS_PROFILE=nakom.is-admin aws cloudformation describe-stack-resources \
  --stack-name Route53Stack --region eu-west-2 \
  --query "StackResources[?ResourceType=='AWS::Route53::HostedZone'].PhysicalResourceId" \
  --output text | tr '\t' '\n' | while read -r id; do
    name=$(AWS_PROFILE=nakom.is-admin aws route53 get-hosted-zone --id "$id" \
      --query 'HostedZone.Name' --output text)
    [ "$name" = "$PARENT." ] && echo "$id"
  done)

AWS_PROFILE=nakom.is-admin aws route53 list-resource-record-sets \
  --hosted-zone-id "$PARENT_ZONE_ID" \
  --query "ResourceRecordSets[?Name=='$SUB.' && Type=='NS']"

# As the internet sees it:
dig NS "$SUB" @"$(dig +short NS "$PARENT" | head -1)" +norec
```

If the record is missing or lists different servers, write it (UPSERT is safe to repeat):

```bash
read -r S1 S2 S3 S4 < <(AWS_PROFILE=nakom.is-sandbox aws route53 get-hosted-zone \
  --id "$SUB_ZONE_ID" --query 'DelegationSet.NameServers' --output text)

AWS_PROFILE=nakom.is-admin aws route53 change-resource-record-sets \
  --hosted-zone-id "$PARENT_ZONE_ID" \
  --change-batch "{
    \"Comment\": \"Restore $SUB delegation\",
    \"Changes\": [{
      \"Action\": \"UPSERT\",
      \"ResourceRecordSet\": {
        \"Name\": \"$SUB\",
        \"Type\": \"NS\",
        \"TTL\": 172800,
        \"ResourceRecords\": [
          {\"Value\": \"$S1\"}, {\"Value\": \"$S2\"}, {\"Value\": \"$S3\"}, {\"Value\": \"$S4\"}
        ]
      }
    }]
  }"
```

Verify:

```bash
dig +trace "$SUB" SOA
dig @1.1.1.1 "$SUB" A
curl -sI "https://$SUB/" | head -1      # sandbox.nakom.is only; see dns-zones.md item 8
```

Then run `npm run smoke:sandbox`.

## 7. Afterwards

- **Records that point at the zone by ID.** `nakomis-infra`'s `AuthCertStack` and `AuthStack`
  hard-code the `nakomis.com` zone ID (`Z019437529YGFB53BDUGR`) and the `sandbox.nakomis.com` zone ID
  (`Z03586633NXU18LFL0JTL`). If either zone was recreated, those IDs must be updated and the stacks
  redeployed, or `login.` and `bounce.` records stay in the old zone.
- **Records outside CloudFormation.** Anything added by hand to the old zone (including the sandbox
  NS records) is not in the new one. Compare the record sets of the old and new zones before deleting
  the old one:

  ```bash
  AWS_PROFILE=nakom.is-admin aws route53 list-resource-record-sets --hosted-zone-id <old-id> \
    --query 'ResourceRecordSets[].[Name,Type]' --output text | sort > /tmp/old.txt
  AWS_PROFILE=nakom.is-admin aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    --query 'ResourceRecordSets[].[Name,Type]' --output text | sort > /tmp/new.txt
  diff /tmp/old.txt /tmp/new.txt
  ```

- **Fill in the incident.** Add a dated entry to the [April 2026 incident](#april-2026-incident)
  section (or a new section for a later one) and update [`docs/dns-zones.md`](../dns-zones.md) if
  anything about ownership or delegation changed.
