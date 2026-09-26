# infra/cdk

CDK v2 (TypeScript) app. Stacks mirror the ARD component groups
(`NetworkStack`, `EdgeStack`, `IngestionStack`, `FetchStack`, `CacheStack`,
`ProcessingStack`, `StorageStack`, `DeliveryStack`, `ObservabilityStack`).

`NetworkStack` is implemented (Multi-AZ VPC, public/private-egress/isolated
subnets, single NAT Gateway in dev). The remaining 8 stacks are empty
placeholders so the app synths end-to-end; each is filled in during its
own phase per the ARD component-group order:

`NetworkStack` → `EdgeStack` → `IngestionStack` → `FetchStack` →
`CacheStack` → `ProcessingStack` → `StorageStack` → `DeliveryStack` →
`ObservabilityStack`

Synth-only at this stage — no `cdk deploy` until explicitly requested.

```
bun run synth   # cdk synth
bun run diff    # cdk diff (needs the target account bootstrapped)
```
