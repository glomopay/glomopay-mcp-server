---
name: glomopay-webhooks
description: How to consume glomo (Glomopay) webhooks correctly - the event catalogue by entity_type and event_type, which events matter for each payin and payout flow, delivery and retry behaviour, why events can arrive duplicated or out of order, how to dedupe with no event ID, and how to reconcile missed events. Use when writing or debugging a webhook handler, or deciding how an integration learns about status changes.
metadata:
  version: "1.0.0"
---

# glomo webhooks

Webhooks are how an integration learns the final state of a payment, payout, refund or subscription. The create response is rarely final. Read `glomopay-integration` first.

## Setup

- Configure the URL and signing secret in the dashboard: Settings > API & Webhooks. Sandbox and live are configured separately. There is no API for managing endpoints.
- The URL must be public HTTPS. `localhost` does not work; use a tunnel in development.
- Every active endpoint on the account receives every event. Two endpoints means each event is delivered twice.
- Platform accounts: a sub-merchant with no active endpoint of its own has its events delivered to the parent account's endpoints. Once the sub-merchant has one, the parent stops receiving them.
- The dashboard has a test action that sends `{"entity_type": "webhook_test", "event_type": "test", ...}`. Accept it and return 200.
- https://docs.glomo.one/platform/webhooks.md

## Verify every request before reading it

The signature is in `X-Glomopay-Signature`: lowercase hex HMAC-SHA256 of the **raw request body** with the webhook secret.

1. Read the raw body bytes before any JSON parsing or framework body middleware.
2. Compute the HMAC-SHA256 hex digest of those exact bytes.
3. Compare to the header in constant time. On mismatch, return 4xx and do nothing else.

Do not parse and re-serialise the body before hashing, and do not canonicalise it yourself. glomo sends the exact bytes it signed. Worked code for several languages: https://docs.glomo.one/platform/webhooks.md

## Payload

```json
{ "entity_type": "payment", "event_type": "success", "data": { "id": "payt_...", "status": "success", ... } }
```

- `data` is the object as it was when the event fired, not necessarily its state now.
- There is **no event ID and no timestamp header**. Dedupe on `entity_type` + `data.id` + `event_type` together with the status in `data`.
- `balance` events have no `data.id` or `data.status`. Dedupe them on `data.payment_id` + `data.timestamp`.

## Handler design

These properties are what make a handler correct under glomo's delivery model:

1. **Acknowledge fast.** Verify, persist the raw event, return 200, then process asynchronously. Delivery times out after 30 seconds, and a timeout counts as a failure and is redelivered even if you processed it.
2. **Idempotent.** The same event can arrive more than once: a redelivery after your slow 200, several endpoints, or a status that legitimately repeats. Processing an event twice must be harmless.
3. **Order-independent.** Delivery order is not guaranteed, and a redelivered event carries its older snapshot. Never let a non-terminal status overwrite a terminal one (for example `in_progress` arriving after `success`). If in doubt, `GET` the object and use its current status.
4. **Unknown events are fine.** Log and 200 any `entity_type` or `event_type` you do not handle. New ones get added.
5. **Reconcile.** A failed delivery (non-2xx or timeout) is retried: in live up to 9 times over about 4 days (1m, 5m, 15m, 1h, 3h, 6h, 12h, 24h, 48h); in sandbox 5 times over about 48 minutes. After that delivery stops. There is no replay or resend, in the dashboard or the API. Run a periodic job that `GET`s objects still in a non-terminal state (list endpoints filter by `status`), so a missed webhook becomes a delay rather than a stuck record.

## Event catalogue

`event_type` values by `entity_type`. Match on these exact strings. Full sample payloads: https://docs.glomo.one/platform/webhooks/glomo-webhooks.md

| entity_type | event_type values |
| --- | --- |
| `payment` | `in_progress`, `success`, `failed`, `action_required`, `under_review`, `funds_available`, `compliance_action_required`, `compliance_under_review`, `compliance_approved`, `compliance_rejected`, `credited_to_beneficiary` (LRS broker flows) |
| `payment_link` | `active`, `paid`, `expired`, `cancelled`, `failed`, `action_required`, `under_review`, `partially_paid` (legacy, not produced by current flows) |
| `orders` | `paid`, `expired`, `cancelled`, `failed`, `action_required`, `under_review`, `partially_paid` (legacy) |
| `refund` | `success`, `failed`, `action_required`, `utr.updated` |
| `payout` | `pending_approval`, `queued`, `in_progress`, `action_required`, `success`, `failed`, `cancelled` |
| `settlement` | same values as `payout` |
| `beneficiary` | `active`, `rejected` |
| `internal_transfer` | `success` |
| `subscription` | `active`, `authorized`, `paused`, `halted`, `completed`, `cancelled`, `expired`, `failed`, `action_required`, `under_review`, `updated`, `payment_method.updated` |
| `virtual_account` | `active`, `inactive` |
| `balance` | `balance.funded_balance.credited` |
| `kyc_journey` | `initiated`, `in_progress`, `action_required`, `under_review`, `completed`, `failed`, `rejected`, `expired` |
| `merchant` (platform accounts only) | `pending`, `action_required`, `success`, `failed`, `offboarded` |
| `amc_folio_transaction` (capital-markets accounts) | `allotment_pending`, `folio_allotted`, `units_allotted`, `failed` |

Notes where the docs and the wire differ:
- A paid payment link or order sends `paid`. One docs sample shows `success`; match on `paid`.
- The entity type for orders is plural: `orders`.
- Every payin that is not an order, including add-funds and account-funding payins, is sent as `entity_type: payment_link`. Expect `payment_link` events for IDs your code did not create, and ignore them rather than failing.
- `in_progress` on `payment` is only sent for some flows (LRS, for example). Do not wait for it.
- Do not rely on `orders.active`, `settlement.initiate` or `internal_transfer.failed`. Handle them if they arrive, but do not block on them.

## Which events finish which flow

| Flow | Treat as done when | Also handle |
| --- | --- | --- |
| Payment link | `payment_link.paid` | `expired`, `cancelled`, `action_required` (RFI at creation) |
| Order + checkout / S2S | `payment.success`, confirmed against the order | `payment.failed`; `orders.paid` |
| LRS remittance | `payment.funds_available` (`success` is only bank authorisation) | `payment.failed` |
| Any successful payment | Money is usable when `funds_available` is true. A payment whose funds were not held arrives as one `payment.success` with `funds_available: true`. A payment whose funds were held (LRS, compliance screening) gets `success` first and `payment.funds_available` when they are released. | `payment.compliance_action_required`: settlement held until the RFI is answered |
| Refund | `refund.success` | `refund.failed`, `refund.action_required`; `utr.updated` adds the bank reference |
| Beneficiary | `beneficiary.active`, before creating payouts | `beneficiary.rejected` |
| Payout | `payout.success` | `payout.failed` / `cancelled` (read `error_code`), `action_required` (RFI, answered in the dashboard), `queued`, `pending_approval` |
| Subscription | `subscription.active`, then `payment.*` per charge | `halted`, `failed`, `cancelled`, `payment_method.updated` |

The browser-side checkout result (SDK event or redirect with `status`) is a UX signal. The webhook, or a server-side `GET`, is the source of truth.
