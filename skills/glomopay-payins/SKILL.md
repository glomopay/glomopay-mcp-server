---
name: glomopay-payins
description: How to collect money with the glomo (Glomopay) API - choosing between payment links, orders with hosted checkout, server-to-server card payments, bank transfers, subscriptions and LRS remittances; the ordered call sequence for each; picking a purpose code from the closed regulator-defined list; payin, payment, refund and subscription status lifecycles; RFIs and action_required; refunds. Use when building or debugging anything that accepts a payment from a customer.
metadata:
  version: "1.0.0"
---

# glomo payins

Read `glomopay-integration` first for auth, amounts, `request_id` and error handling. This skill is about choosing the right flow and knowing what each state means. Take field shapes from https://docs.glomo.one/openapi.yaml.

## Choose the flow

| The merchant wants to... | Flow | Start with |
| --- | --- | --- |
| Send the customer a link; no frontend work | Payment link (`POST /payin`) | https://docs.glomo.one/payin/payment-link.md |
| Embed checkout in their own site or app | Order (`POST /orders`) + glomo checkout SDK | https://docs.glomo.one/payin/checkout.md |
| Take card details on their own PCI-DSS certified surface | Order + `POST /payment` (S2S) | https://docs.glomo.one/payin/server-to-server-payments.md |
| Charge on a schedule or on demand | Subscription | https://docs.glomo.one/payin/subscriptions/set-up.md |
| Remit funds abroad for a resident Indian under LRS | LRS order | https://docs.glomo.one/payin/resident-india-remittance-under-lrs/set-up.md |
| Receive bank wires into a virtual account | Bank transfer | https://docs.glomo.one/payin/payment-methods/bank-transfer.md |


Constraints that decide the flow:
- The checkout SDK opens an order or a subscription. Both are created server-side with the secret key, never from the browser.
- S2S is only for merchants who are PCI-DSS certified. Otherwise use checkout.
- Subscriptions are cards only. Bank transfer cannot be recurring, and Indian-issued cards are not supported for subscriptions.
- The bank transfer "Set up bank transfers" page is still a placeholder. Do not infer a call order from it; confirm the flow with glomo.

## Every flow starts with a customer

`POST /customer` first, and store the returned `cust_` ID against your user. Orders and payment links require one.
- Names: 2-128 characters, only letters, digits, spaces and `& . , ' -`. Strip underscores and accents before sending.
- Only `email` and `phone` can be changed afterwards. Get the name, type and address right on create.
- Customers are unique per merchant, by default on email + country. A duplicate is a 400 ("Email has already been taken"); look the customer up, do not create a near-duplicate.
- LRS customers resident in India have stricter rules (letters, digits and spaces only in the name; phone required; PAN via `kyc`). See the LRS guide.

## Ordered sequences

**Payment link**: `POST /customer` → `POST /payin` → the customer opens the glomo-hosted link (email one-time verification) and pays → `payment_link` webhook with `paid`. Cancel an unpaid link with `PATCH /payin/{id}/cancel` (payment links only; orders cannot be cancelled over the API). `POST /payin` has no `request_id`, so check for an existing link before retrying a timed-out create.

**Order + checkout**: `POST /customer` → `POST /orders` (server, with `request_id`) → open checkout in the frontend with the order ID and publishable key → the SDK reports success or failure, or redirects to your `callbackUrl` → verify on the server. The signature is HMAC-SHA256 with the secret key over `order_id|payment_id|status`, so you need the payment ID; use your server-side order ID, not the one from the browser (recipe in the checkout guide). If the redirect has no payment ID or no signature, do not trust its `status`: look the payment up server-side. Treat the webhook or `GET /payment/{id}` as final. If you set `callbackUrl`, the SDK events do not fire. `payment.bank_transfer_submitted` means the customer says they sent a transfer, not that money arrived.

**S2S card**: `POST /orders` (or `POST /subscriptions`) → `POST /payment` with exactly one of `order_id` or `subscription_id`, the card, a `request_id` and an HTTPS `callback_url` → redirect the customer to the returned URL for 3DS → the callback carries `status` and `signature`; verify it → rely on webhooks for the final state.

**Subscription**: `POST /subscriptions` with `interval_type` `month`, `year` or `as_presented` ("fixed frequency" in the docs means `month` / `year`; it is not a value you send) → first charge through checkout or S2S → pause, resume, cancel or move the next date with the `PATCH` endpoints. For `as_presented`, send `max_amount` and do not send `interval_count`, `billing_cycles` or `start_date`. Later charges are `POST /payment` with `sequence: subsequent`, `amount`, `currency` and a fresh `request_id`, capped at `max_amount`.

**LRS**: follow the guide step by step. It has its own quote call (not in the OpenAPI description), a customer bank account step and a beneficiary step. Two things agents get wrong: `payment.success` only means the bank authorised the remittance, and `payment.funds_available` is the signal that money landed. While an earlier attempt on an order is still in progress, a new attempt is rejected with 400 ("The order has an existing in progress payment") until that attempt resolves or expires. Create a new order instead of waiting; failed attempts do not block.

## Purpose codes are a closed list

`purpose_code` is not free text. Values come from a fixed, regulator-defined list. `payment_for_goods`, `PYR001` and similar guesses are rejected.

- Payin codes look like `P####`. The list, with descriptions and required documents: https://docs.glomo.one/payin/purpose-codes.md
- Payout codes are a different list and are rejected on a payin. Codes in payout examples, such as `PYR002`, are payout codes. Never copy them into a payin.
- LRS is the exception: LRS orders accept only `S0001` or `S0002`, which are valid payin codes despite the `S` prefix. See the LRS guide for which to use.
- To pick one: find the purpose group that matches the merchant's business (Other Business Services, Telecom, Computer & Information Services, Transport, Travel...), then the code whose description matches what is being paid for. Examples: software consultancy or implementation is `P0802`; business and management consultancy is `P1006`.
- Check the "Documents" column. Most codes need an invoice. Collecting it up front avoids an RFI later.
- If the merchant's goods or services do not clearly fit one code, ask the developer. Do not pick the nearest-sounding one; the code is part of the regulatory record.
- The merchant account can have a default payin purpose code. Without one, `purpose_code` is required on payment links. On orders it is optional and the default applies. Send it anyway so the choice is explicit.

## Status lifecycles

Match on these public values. Some prose pages still use older names (Created, Attempted, Success, Cleared).

**Orders and payment links**: `active` (awaiting payment) → `paid`. Also `expired`, `cancelled` (payment links), `failed`, `action_required`, `under_review`. `partially_paid` exists in the enum but current flows do not produce it.
- Terminal: `paid`, `failed`, `cancelled`, `expired`. A bank transfer that arrives for a payin that is no longer `active` does not revive it; the payment lands `action_required` with `PAYIN_NOT_FOUND` (see below).
- `action_required` at creation means compliance needs documents. The create response lists `rfi_documents`. Upload with `POST /document`, then `PATCH /orders/{id}/update-rfi` or `PATCH /payin/{id}/update-rfi` → `under_review` → `active`. Both paths use a hyphen; the underscore form in the published spec returns 404.
- Expiry: orders take no `expires_at` and expire 3 months after creation, or with their quote when created from one (LRS orders always are). Payment links accept `expires_at`, at most 6 months out.

**Payment**: `in_progress` → `success` or `failed`; or `action_required` → `under_review`.
- `compliance_status` is a separate field on a successful payment: `under_review`, `action_required`, `approved`, `rejected`. A payment can be `success` with `compliance_status: action_required`: money was received but settlement is held until the RFI is answered. The payment carries `rfi_id`; `GET /rfis/{id}` shows what is needed (`GET /rfis` lists them all), then `POST /document` and `PATCH /rfis/{id}/respond`. An unanswered RFI expires. https://docs.glomo.one/request-for-information/compliance-reviews-and-rfis-on-successful-payments.md
- A bank transfer that arrives with no matching active payin or the wrong amount leaves the payment `action_required` with `error_code` `PAYIN_NOT_FOUND` or `PAYIN_AMOUNT_MISMATCH`. Fix it over the API with a quote for the amount received, a new payin, then `GET /payment/{id}/eligible-payins` and `POST /payment/{id}/connect-payin`. Sanctions or monitoring holds (`SANCTION_HIT`, `TXM_HOLD`) cannot be fixed this way; they go to support. https://docs.glomo.one/payin/action-required.md

**Refund**: `in_progress` → `success` or `failed`; also `action_required`, `under_review`, `cancelled`. The spec enum shows `pending`; the API returns `in_progress`.

**Subscription**: `created` → `authorized` / `active` → `paused` / `halted` (resumable) → `completed`, `cancelled`, `expired` or `failed` (terminal). `action_required` → `under_review` also occur.

## Refunds

- Only `success` payments, within 180 days, back to the original payment method only. Funded from the merchant's glomo balance.
- Not refundable: pay-via-bank payments, add-funds payments, payments with compliance-withheld funds, payments with an open or lost chargeback.
- Partial refunds are cards only and only if enabled for the account. Otherwise a partial `amount` is a 400 ("Partial refunds are not enabled for this business"); nothing is refunded.
- Several partial refunds are allowed, up to the remaining amount.
- Send a `request_id`. Responses: 201 when the refund is already `success`; 202 when it is in progress, under review or action required; 422 with the refund object as the body when it failed or was cancelled at creation. A repeated `request_id` is a 400 "Refund already exists for this request_id". "Refund is being processed" (409) is a lock on that payment; wait and retry.
- Timing: cards take 4-7 business days, bank transfers 1-3.

## Mistakes to avoid

- Marking an order paid from the browser callback without verifying the signature and the webhook.
- Treating `payment.success` as money-in-hand for LRS, or ignoring `compliance_status` on a successful payment.
- Sending `amount` or `currency` together with `quote_id`.
- Creating a new customer per order instead of reusing the stored `cust_` ID.
- Retrying a timed-out payment link create without checking whether the first one exists.
- Waiting on or retrying an in-progress LRS attempt instead of creating a new order.
