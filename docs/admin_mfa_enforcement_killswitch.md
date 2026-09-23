# Admin MFA Enforcement Kill-Switch

Built 2026-09-01/02: TOTP-based admin MFA (enrollment + verification callables in `functions/src/admin/adminMfa.ts`, enforcement check in `functions/src/utils/adminAuth.ts`'s `assertAdmin`). Classified as already-paid Milestone 1 scope ("MFA enforcement for admins" is named in M1's accepted contract text), so built for free, not new billable work.

Enforcement is gated OFF by a kill-switch constant `MFA_ENFORCEMENT_ENABLED = false` at the top of `adminAuth.ts`. Every existing admin already has `mfaRequired: true` (set unconditionally by `acceptAdminInvite` since it was built) but none has ever enrolled, since no Ops Console UI calls the new enrollment callables yet. Flipping the flag on before that UI exists would lock every current admin out with no recovery but a manual Firestore edit.

**Why:** This ships the reviewed code now (visible in the repo for audit purposes) while keeping zero operational risk, instead of deploying enforcement immediately with a manual pre-enrollment script.

**How to turn it on:** Do not flip `MFA_ENFORCEMENT_ENABLED` to `true` until the Ops Console ships a real enrollment screen calling `beginAdminMfaEnrollment`/`confirmAdminMfaEnrollment`, and active admins have actually enrolled through it. Turning it on is a one-line flip in `adminAuth.ts`; nothing else needs to change.
