---
name: glomopay-payins
description: How to collect money with the glomo (Glomopay) API - choosing between payment links, orders with hosted checkout, server-to-server card payments, bank transfers, subscriptions and LRS remittances; the ordered call sequence for each; picking a purpose code from the closed regulator-defined list; payin, payment, refund and subscription status lifecycles; RFIs and action_required; refunds. Use when building or debugging anything that accepts a payment from a customer.
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
- The checkout SDK needs an order. Orders are created server-side with the secret key, never from the browser.
- S2S is only for merchants who are PCI-DSS certified. Otherwise use checkout.
- Subscriptions are cards only. Bank transfer cannot be recurring, and Indian-issued cards are not supported for subscriptions.
- The bank transfer "Set up bank transfers" page is still a placeholder. Do not infer a call order from it; confirm the flow with glomo.

## Every flow starts with a customer

`POST /customer` first, and store the returned `cust_` ID against your user. Orders and payment links require one.
- Names: 2-128 characters, only letters, digits, spaces and `& . , ' -`. Strip underscores and accents before sending.
- Only `email` and `phone` can be changed afterwards. Get the name, type and address right on create.
- Customers are unique by email. On a conflict, look the customer up; do not create a near-duplicate.
- LRS customers resident in India have stricter rules (letters, digits and spaces only in the name; phone required; PAN via `kyc`). See the LRS guide.

## Ordered sequences

**Payment link**: `POST /customer` → `POST /payin` → the customer opens the glomo-hosted link (email one-time verification) and pays → `payment_link` webhook with `paid`. Cancel an unpaid link with `PATCH /payin/{id}/cancel`.

**Order + checkout**: `POST /customer` → `POST /orders` (server) → open checkout in the frontend with the order ID and publishable key → the SDK reports success or failure, or redirects to your `callbackUrl` with `status`, `orderId` and `signature` → verify the signature on the server (HMAC-SHA256 with the secret key; recipe in the checkout guide; use your server-side order ID, not the one from the browser) → treat the webhook or `GET /payment/{id}` as final. If you set `callbackUrl`, the SDK events do not fire. `payment.bank_transfer_submitted` means the customer says they sent a transfer, not that money arrived.

**S2S card**: `POST /orders` (or `POST /subscriptions`) → `POST /payment` with exactly one of `order_id` or `subscription_id`, the card, and an HTTPS `callback_url` → redirect the customer to the returned URL for 3DS → the callback carries `status` and `signature`; verify it → rely on webhooks for the final state.

**Subscription**: `POST /subscriptions` (`fixed_frequency` or `as_presented`) → first charge through checkout or S2S → pause, resume, cancel or move the next date with the `PATCH` endpoints. For `as_presented`, send `max_amount` and do not send `interval_count`, `billing_cycles` or `start_date`. Later charges are `POST /payment` with `sequence: subsequent`, `amount`, `currency` and a fresh `request_id`, capped at `max_amount`.

**LRS**: follow the guide step by step. It has its own quote endpoint, a customer bank account step and a beneficiary step. Two things agents get wrong: `payment.success` only means the bank authorised the remittance, and `payment.funds_available` is the signal that money landed. A failed LRS attempt blocks retries on the same order for about 35 minutes, so create a new order instead.

## Purpose codes are a closed list

`purpose_code` is not free text. Values come from a fixed, regulator-defined list. `payment_for_goods`, `PYR001` and similar guesses are rejected.

- Payin codes look like `P####`. The list, with descriptions and required documents: https://docs.glomo.one/payin/purpose-codes.md
- Payout codes (`S####`) are a different list and are rejected on a payin. Codes in payout examples, such as `PYR002`, are payout codes. Never copy them into a payin.
- To pick one: find the purpose group that matches the merchant's business (Other Business Services, Telecom, Computer & Information Services, Transport, Travel...), then the code whose description matches what is being paid for. Examples: software consultancy or implementation is `P0802`; business and management consultancy is `P1006`.
- Check the "Documents" column. Most codes need an invoice. Collecting it up front avoids an RFI later.
- If the merchant's goods or services do not clearly fit one code, ask the developer. Do not pick the nearest-sounding one; the code is part of the regulatory record.
- Required on payment links. Optional on orders, where the merchant's default code applies if omitted; send it anyway so the choice is explicit.

## Status lifecycles

Match on these public values. Some prose pages still use older names (Created, Attempted, Success, Cleared).

**Orders and payment links**: `active` (awaiting payment) → `paid`. Also `partially_paid`, `expired`, `cancelled`, `failed`, `action_required`, `under_review`.
- Terminal: `paid`, `failed`, `cancelled`. An `expired` payin can still become `paid` if a late bank transfer is matched to it.
- `action_required` at creation means compliance needs documents. The create response lists `rfi_documents`. Upload with `POST /document`, then `PATCH /orders/{id}/update-rfi` or `PATCH /payin/{id}/update_rfi` → `under_review` → `active`.
- Orders default to a 3-month expiry, and never more than 6 months.

**Payment**: `in_progress` → `success` or `failed`; or `action_required` → `under_review`.
- `compliance_status` is a separate field on a successful payment: `under_review`, `action_required`, `approved`, `rejected`. A payment can be `success` with `compliance_status: action_required`: money was received but settlement is held until the RFI is answered (`GET /rfis`, `POST /document`, `PATCH /rfis/{id}/respond`). An unanswered RFI expires. https://docs.glomo.one/request-for-information/compliance-reviews-and-rfis-on-successful-payments.md
- A bank transfer that arrives with no matching payin or the wrong amount leaves the payment `action_required` with `error_code` `PAYIN_NOT_FOUND` or `PAYIN_AMOUNT_MISMATCH`. Fix it over the API with a quote for the amount received, a new payin, then `GET /payment/{id}/eligible-payins` and `POST /payment/{id}/connect-payin`. Sanctions or monitoring holds cannot be fixed this way; they go to support. https://docs.glomo.one/payin/action-required.md

**Refund**: `in_progress` → `success` or `failed`; also `action_required`, `under_review`, `cancelled`. The spec enum shows `pending`; the API returns `in_progress`.

**Subscription**: `created` → `authorized` / `active` → `paused` / `halted` (resumable) → `completed`, `cancelled`, `expired` or `failed` (terminal). `action_required` → `under_review` also occur.

## Refunds

- Only `success` payments, within 180 days, back to the original payment method only. Funded from the merchant's glomo balance.
- Not refundable: pay-via-bank payments, add-funds payments, payments with compliance-withheld funds, payments with an open or lost chargeback.
- Partial refunds are cards only and only if enabled for the account. If they are not, `amount` is ignored and the full payment is refunded. Check the refunded amount in the response before telling the user.
- Several partial refunds are allowed, up to the remaining amount.
- Send a `request_id`. 201 means created; 202 means pending or under review. "Refund is being processed" (409) is a lock on that payment; wait and retry.
- Timing: cards take 4-7 business days, bank transfers 1-3.

## Mistakes to avoid

- Marking an order paid from the browser callback without verifying the signature and the webhook.
- Treating `payment.success` as money-in-hand for LRS, or ignoring `compliance_status` on a successful payment.
- Sending `amount` or `currency` together with `quote_id`.
- Creating a new customer per order instead of reusing the stored `cust_` ID.
- Retrying a failed LRS order instead of creating a new one.
