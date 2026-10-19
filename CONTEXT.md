# tokengate

tokengate lets workloads use credentials without receiving their secrets.

## Language

**Credential**:
A secret together with the destination and authentication settings for using it.
_Avoid_: Service token, service

**Issuer**:
The issuer of a workload's signed identity token, identified by its issuer URL. It is a value in each credential and global access rule, not an independently managed resource or the provider used to sign in to the app.
_Avoid_: Service consumer, consumer, identity provider

**Credential access rule**:
A permission for workloads whose tokens one issuer signs, and that match its identity conditions, to use exactly one credential for the operations it lists. It holds its own token verification settings. The global access rules of its issuer limit it. Short form: access rule.
_Avoid_: Issuer access rule, grant, consumer access, boundary

**Global access rule**:
A ceiling that an administrator sets on every credential access rule of one issuer. It can limit the token settings, the identity conditions and the operations, and it never lets a workload in by itself. An issuer without a global access rule is not limited; an issuer whose global access rules are all disabled or expired admits nothing.
_Avoid_: Boundary, issuer access rule, default rule

**Caller**:
A workload, such as a CI job, presenting a signed identity token to use a credential.
