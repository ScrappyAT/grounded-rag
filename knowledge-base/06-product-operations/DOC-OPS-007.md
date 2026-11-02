---
id: "DOC-OPS-007"
title: "Outbound Merchant Webhook Delivery, Retries and Dead-Letter Policy"
category: "06-product-operations"
department: "Product Operations"
version: "2.1"
effective_date: "2026-01-18"
status: "active"
file_type: "markdown"
---
# Outbound Merchant Webhook Delivery, Retries and Dead-Letter Policy
> **Document ID:** `DOC-OPS-007` | **Version:** 2.1 | **Effective Date:** 2026-01-18 | **Status:** ACTIVE
## Section 1: Event Dispatch Mechanism

Webhooks notify merchant systems asynchronously when payment states transition to succeeded, failed, refunded, or reversed.

## Section 4: Webhook Retry Policy

ApexPay retries failed webhooks 5 times using exponential backoff: immediately, then after 5 minutes, 30 minutes, 2 hours, and 12 hours. If all attempts fail, the event is marked dead-lettered. Merchants can manually redeliver dead-lettered events via the developer portal.

## Section 5: Webhook Signature Verification

Every webhook payload includes an X-ApexPay-Signature header computed using HMAC-SHA256 with the merchant's secret webhook key.
