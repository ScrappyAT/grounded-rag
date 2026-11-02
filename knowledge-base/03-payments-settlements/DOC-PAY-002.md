---
id: "DOC-PAY-002"
title: "Domestic Bank Transfer Rails & NIP Merchant Settlement Schedules"
category: "03-payments-settlements"
department: "Payments & Settlements"
version: "2.2"
effective_date: "2026-01-20"
status: "active"
file_type: "markdown"
---
# Domestic Bank Transfer Rails & NIP Merchant Settlement Schedules
> **Document ID:** `DOC-PAY-002` | **Version:** 2.2 | **Effective Date:** 2026-01-20 | **Status:** ACTIVE
## Section 1: Domestic Rail Infrastructure

ApexPay routes domestic bank transfers through direct integration with NIBSS Instant Payments (NIP) and designated commercial clearing banks.

## Section 2: Domestic Settlement Schedules

Domestic NIP transactions settle on a T+1 business day basis at 10:00 AM WAT, provided the merchant account has passed post-transaction risk clearance. Transactions finalized on Fridays, weekends, or statutory holidays are settled on the next operational clearing day.

## Section 3: Accelerated Same-Day Settlement Exception Criteria

Standard merchant payouts settle on a T+1 business day basis. To qualify for an operational exception granting accelerated same-day (T+0 intraday) settlement, a merchant must satisfy all of the following mandatory qualification criteria:
1. Minimum operating history of at least 6 consecutive months on the ApexPay platform.
2. Rolling reserve compliance with a 10% rolling reserve maintained across a rolling 90-day settlement window.
3. Cumulative dispute and chargeback ratio maintained strictly below 0.5% of total transaction volume.
4. Sustained average monthly processed transaction volume exceeding 5,000,000 NGN.
5. Formal risk clearance and underwriting approval from the Payments & Settlements Risk Committee.
6. Acceptance of the 0.25% surcharge fee per same-day payout batch.
