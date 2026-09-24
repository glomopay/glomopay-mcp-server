---
name: glomopay-testing
description: How to verify a glomo (Glomopay) integration end to end in sandbox before shipping - getting test keys, the sandbox-only mock endpoints that simulate inbound payments, payout and refund outcomes, beneficiary review, funds availability and settlement; the reserved 6623 amount that forces a sanctions-screening hit; test cards; step-by-step recipes to drive each flow to success and failure; and what sandbox cannot simulate. Use when testing, writing integration tests, or checking that generated glomo API code actually works.
---

# glomo sandbox testing

Do not hand over glomo integration code that has only been reasoned about. Run it against sandbox, read the real responses, and fix anything that disagrees with what you assumed. Read `glomopay-integration` first.

## Sandbox basics

- Test keys come from the dashboard, Settings > API Keys, with the account in Test mode. New accounts have test keys only.
- Same base URL as live, `https://api.glomopay.com/api/v1`. A test key routes to sandbox. Nothing about the URL changes between environments; only the key does.
- Sandbox data never exists in live. IDs, customers and beneficiaries created with a test key have to be recreated with the live key.
- Webhooks for sandbox are configured separately in the dashboard. Point them at a public HTTPS tunnel during development.
- The mock endpoints below exist only in sandbox. In live they return 404, so never call them from production code paths. Keep them in test helpers.

## Mock endpoints

Use these to move objects into the states a real bank, rail or compliance analyst would. Schemas: https://docs.glomo.one/openapi.yaml (search for `mock`).

| Call | Simulates | Result |
| --- | --- | --- |
| `POST /payment/mock` `{amount, currency, payin_id}` | Customer pays a payment link or order by bank transfer | Screening, then a `success` payment against that payin. The payin must still be `active` (else `PAYIN_NOT_FOUND`), and `amount` must equal the payin's amount in the mocked currency (else `PAYIN_AMOUNT_MISMATCH`); both leave the payment `action_required`. |
| `POST /payment/mock` `{amount, currency, payment_method: "BankTransfer"}` | An inbound transfer with no payin | A bank-transfer payment with nothing to match (to test action_required handling) |
| `PATCH /payment/{id}/mock-funds-available` | Funds clear | `funds_available` set, `payment.funds_available` webhook |
| `PATCH /payin/{id}/mock_mark_reviewed` | Compliance finishes reviewing a payment link | Payment link `under_review` → `active` |
| `PATCH /v2/beneficiaries/{id}/mock-review` `{review_action: "approve" \| "reject"}` | Beneficiary review | `pending` → `active` or `rejected` (422 if not `pending`) |
| `PATCH /payouts/mock` `{id, status}` | The rail's outcome | `pending`, `success`, `failed`, `action_required` or `cancelled`, only along legal transitions. `action_required` is only reachable from `pending_approval`, `queued` or under review, not from a freshly processing payout. A mocked `failed` has `error_code: null`. |
| `PATCH /refunds/{id}/mock_update_status` `{status: "success" \| "failed"}` | The bank's refund outcome | `success` only once the refund has been sent to the bank; called earlier it errors (currently a 500, not a 400), so `GET` the refund and retry shortly |
| `POST /settlements/mock-trigger` | The settlement run | Settles eligible funds (USD, EUR, GBP, AED, SGD) |
| `PATCH /platform/merchants/status-update` `{merchant_id, target_status: "success"}` | Onboarding approval of a child merchant (platform accounts) | Child merchant → `success` |

A 400 "State change not allowed" from `/payouts/mock` means the payout was not in the state you assumed. `GET` it and step through the lifecycle in order. Do not force a jump.

## Reserved test values

- **Amount `6623`** (minor units, any currency): forces a sanctions-screening hit. What you get depends on whether post-payment screening is enabled for the account (it is off by default; ask glomo):
  - Enabled: the payment succeeds, `compliance_status` becomes `action_required`, a payment-screening RFI is raised (`rfi_id` on the payment) and settlement is held. Test RFI handling with `GET /rfis/{id}`, `POST /document`, `PATCH /rfis/{id}/respond`. https://docs.glomo.one/request-for-information/compliance-reviews-and-rfis-on-successful-payments.md
  - Not enabled: the payment itself goes `action_required` with `error_code: SANCTION_HIT` and no RFI. That hold goes to support; it cannot be fixed over the API.
  - Test cards that carry their own compliance outcome are not affected by `6623`.
- **Test cards** for checkout and S2S, including 3DS/OTP and decline cases (`INSUFFICIENT_BALANCE`, `CARD_NOT_SUPPORTED_ON_3DS`): https://docs.glomo.one/payin/payment-methods/cards.md. In sandbox, a card number not on that list is rejected with 400 "Card is not a valid test card". Never use a real card number.

Use only values from these pages. Do not invent magic values.

## Recipes

Run each to its terminal state and check both the API response and the webhook your handler received.

**Payment link paid**: `POST /customer` → `POST /payin` → `POST /payment/mock {amount, currency, payin_id}` → expect `payment.success` and `payment_link.paid`. If the link was created `under_review`, call `mock_mark_reviewed` first.

**Order paid by card**: `POST /customer` → `POST /orders` → open checkout (or S2S `POST /payment`) with a test card → complete 3DS → verify the callback signature → expect `payment.success`.

**Declined card**: same, with a decline test card → expect `payment.failed`, and check that your UI shows the reason.

**Compliance hold**: as payment link paid, with `amount: 6623`. With post-payment screening enabled: expect `payment.success`, then `compliance_status: action_required` and an RFI → respond → expect the compliance status to move on. Without it: expect the payment `action_required` with `SANCTION_HIT`, and check your code routes it to a human instead of retrying.

**Unmatched bank transfer**: `POST /payment/mock {amount, currency, payment_method: "BankTransfer"}` → expect an `action_required` payment → resolve with a quote, a new payin and `connect-payin` (`glomopay-payins`).

**Funds and settlement**: a paid payment → `mock-funds-available` if not already available → `POST /settlements/mock-trigger` → expect `settlement` webhooks.

**Payout success and failure**: `POST /v2/beneficiaries` → `mock-review approve` if `pending` → `POST /payouts` → `PATCH /payouts/mock {id, status: "success"}`. Repeat with `failed`; the mocked failure has `error_code: null`, so check your handler copes with a missing code (real failures carry one). `action_required` can only be mocked on accounts with queueing or maker-checker, while the payout is `queued` or `pending_approval`. Also test `mock-review reject` and confirm your code refuses to pay a rejected beneficiary (the payout create is a 400).

**Refund**: a successful payment → `POST /refunds` with a `request_id` → `PATCH /refunds/{id}/mock_update_status {status: "success"}` → expect `refund.success`. Send the same `request_id` again and expect 400 "Refund already exists for this request_id".

**Idempotency**: for every create call that takes a `request_id`, send it twice and confirm your code treats the duplicate response as "already done" and does not create a second object: 409 for payouts, 400 "already exists for this request_id" for orders, payments and refunds. Payment links have no `request_id`; check that a retried link create looks for an existing link first.

**LRS**: follow the sandbox notes in https://docs.glomo.one/payin/resident-india-remittance-under-lrs/set-up.md. Sandbox LRS payment success is set from the dashboard, not by a mock endpoint.

## What sandbox cannot do

- Trigger a subscription renewal charge on demand. The closest is `PATCH /subscriptions/{id}/next-payment-date` on an active, non-`as_presented` subscription: set a date at least 2 days ahead (UTC), and the daily renewal run (about 06:30 IST) charges it on that date. The card decides the renewal outcome; see the test cards page.
- Raise chargebacks or disputes through the API.
- Expire an RFI on demand.
- Simulate mock payments by card or pay-via-bank. `/payment/mock` is bank transfer only; cards go through checkout with test cards.
- Settle currencies other than USD, EUR, GBP, AED and SGD.
- Confirm account preconditions. A feature enabled in sandbox may not be enabled in live yet. Check with glomo before going live.

## Done means

Every flow the integration uses has been driven to success and to at least one failure in sandbox. Webhook handling has been checked for duplicates and out-of-order delivery (`glomopay-webhooks`). The only change for live is swapping test keys for live keys.
