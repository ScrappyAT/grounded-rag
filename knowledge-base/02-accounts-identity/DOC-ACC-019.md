---
id: "DOC-ACC-019"
title: "User Authentication Failures, Lockout Protocols and Recovery"
category: "02-accounts-identity"
department: "Accounts & KYC"
version: "1.2"
effective_date: "2025-08-14"
status: "active"
file_type: "markdown"
---
# User Authentication Failures, Lockout Protocols and Recovery
> **Document ID:** `DOC-ACC-019` | **Version:** 1.2 | **Effective Date:** 2025-08-14 | **Status:** ACTIVE
## Section 1: Authentication Safeguards

ApexPay enforces adaptive risk-based authentication for web, mobile, and API logins.

## Section 5: Failed Authentication and Account Lockout

The account is placed on an automatic 30-minute security lock. An automated security email is dispatched to the registered address containing a secure unlock link and instructions to reset the password. Customer support representatives cannot manually bypass the 30-minute lock without secondary biometric verification.

## Section 6: Biometric Session Recovery

Users with pre-enrolled Passkeys or WebAuthn credentials may initiate immediate recovery via device-bound biometrics.
