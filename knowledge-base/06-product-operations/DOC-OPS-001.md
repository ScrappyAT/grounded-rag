---
id: "DOC-OPS-001"
title: "Public Developer REST API Rate Limiting and Tier Quotas"
category: "06-product-operations"
department: "Product Operations"
version: "2.0"
effective_date: "2026-01-01"
status: "active"
file_type: "markdown"
---
# Public Developer REST API Rate Limiting and Tier Quotas
> **Document ID:** `DOC-OPS-001` | **Version:** 2.0 | **Effective Date:** 2026-01-01 | **Status:** ACTIVE
## Section 1: API Architecture

ApexPay provides stateless REST and GraphQL APIs for merchant checkout integration, payouts, and webhook configurations.

## Section 3: API Key Rate Limits

Standard API keys are throttled at 60 requests per minute and 10,000 requests per 24-hour rolling window per merchant organization. Requests exceeding these thresholds receive HTTP status 429 Too Many Requests with standard Retry-After headers.

## Section 4: Enterprise Rate Limit Overrides

Enterprise clients may request quota expansion up to 1,000 requests per minute following architecture review and traffic profile submission.
