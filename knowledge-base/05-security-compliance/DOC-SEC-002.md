---
id: "DOC-SEC-002"
title: "Privileged Infrastructure Access, Password Standards and Rotation"
category: "05-security-compliance"
department: "Security & Compliance"
version: "2.2"
effective_date: "2026-01-08"
status: "active"
file_type: "markdown"
---
# Privileged Infrastructure Access, Password Standards and Rotation
> **Document ID:** `DOC-SEC-002` | **Version:** 2.2 | **Effective Date:** 2026-01-08 | **Status:** ACTIVE
## Section 1: Scope of Privileged Access

Applies to all database administrators, cloud infrastructure architects, DevOps personnel, and senior backend engineers with production access.

## Section 3: Privileged Access Password Standards

Privileged staff passwords must be at least 16 characters long with uppercase, lowercase, numbers, and symbols, and must be rotated every 90 days. Hardware token 2FA is mandatory. Passwords may not reuse the previous 12 historical passwords.

## Section 4: Hardware Token Enforcement

FIDO2-compliant physical YubiKey tokens are mandatory for all production bastion host and VPN logins.
