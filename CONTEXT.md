# tokengate

tokengate lets workloads use credentials without receiving their secrets.

## Language

**Credential**:
A secret together with the destination and authentication settings for using it.
_Avoid_: Service token, service

**Issuer**:
The issuer of a workload's signed identity token, identified by its issuer URL. It is a value in an access rule, not an independently managed resource or the provider used to sign in to the app.
_Avoid_: Service consumer, consumer, identity provider

**Issuer access rule**:
A permission for workloads matching an issuer and identity filters to use a credential for specified operations, within that credential's allowed limits.
_Avoid_: Consumer access, grant

**Credential access rule**:
A boundary set by a credential administrator describing the issuers and identity filters that may receive access to that credential. A boundary does not grant access by itself.

**Caller**:
A workload, such as a CI job, presenting a signed identity token to use a credential.
