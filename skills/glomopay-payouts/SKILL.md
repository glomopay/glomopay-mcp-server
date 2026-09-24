---
name: glomopay-payouts
description: How to send money with the glomo (Glomopay) API - creating and approving v2 beneficiaries, choosing a payout rail (UPI, IMPS, NEFT, RTGS, IPP, FTS, SEPA, FPS, SWIFT), with-quote vs without-quote payouts, payout purpose codes, the payout status lifecycle, which failures to retry, cancellation rules, queued payouts, balances and RFIs. Use when building or debugging anything that pays a beneficiary.
---

# glomo payouts

Read `glomopay-integration` first for auth, amounts, `request_id` and error handling. A payout moves real money, so the rules here are about never paying twice and never retrying a failure that needs a human. Take field shapes from https://docs.glomo.one/openapi.yaml.

## Ordered sequence

1. **Beneficiary**: `POST /v2/beneficiaries` with `category: payout`. Store the `bene_` ID. There is no v1 beneficiary API.
2. **Wait until the beneficiary is `active`.** If the account reviews beneficiaries, new ones start `pending` and move to `active` or `rejected` (`beneficiary` webhook, or `GET /v2/beneficiaries/{id}`). Other accounts create them `active` straight away. A payout to a `pending` or `rejected` beneficiary fails.
3. **Documents** if the purpose code needs them: `POST /document`, then pass the `doc_` IDs in the payout's `documents`.
4. **Quote** (optional): `POST /quotes` with `resource: payout`. Returns one option per eligible rail with the rate and fees, valid 30 minutes, usable once.
5. **Payout**: `POST /payouts` with a deterministic `request_id`.
6. **Outcome**: `payout` webhooks, with `GET /payouts/{id}` or `GET /payouts?request_id=` to reconcile.

Guide: https://docs.glomo.one/payout/create.md. Lifecycle: https://docs.glomo.one/payout/life-cycle.md

## With or without a quote

- **With `quote_id`**: the quote fixes amounts, currencies and rail. Do not send `source_amount`, `destination_amount`, currencies or `payment_rail` as well; that is a 400. Use this when the user must approve the exact rate and fee, or when you need to know which rails the corridor supports.
- **Without a quote**: send the amounts, currencies and `payment_rail` yourself; glomo prices it at creation. Simpler for known corridors.
- LRS repatriation payouts (USD to INR back to an investor) cannot use a quote. Follow https://docs.glomo.one/payin/resident-india-remittance-under-lrs/set-up/withdrawal-flow-guide.md

## Choosing the rail

**If you omit `payment_rail`, the payout goes by SWIFT.** A local rail is never picked for you. For INR, EUR, GBP and AED, set the rail explicitly or you pay SWIFT fees and wait SWIFT times.

| Destination | Rails | Beneficiary needs |
| --- | --- | --- |
| INR | `upi`, `imps`, `neft`, `rtgs` | Account number + IFSC in `local_routing_number`, or a UPI ID for `upi` |
| AED | `ipp` (up to AED 50,000), `fts` | IBAN |
| EUR | `sepa` | IBAN |
| GBP | `fps` | Domestic account number + sort code. A GB IBAN alone does not qualify for `fps`. |
| Anything else | `swift` | Account number + `swift_code` (BIC); the BIC country must match the bank address country |

Per-rail limits and details: https://docs.glomo.one/payout/rails.md. Only use rail values from that page and the spec enum.

- A beneficiary is eligible for a rail only if it holds that rail's identifiers. Collect them when you create the beneficiary.
- SWIFT payouts are processed manually and are slower than local rails.
- INR rails run on Indian bank working days; SWIFT on FX business days. Check https://docs.glomo.one/multi-currency-account/settlement-holidays.md before promising a date.
- For INR local rails, the purpose code must also be valid for the rail, or you get "not a valid purpose code for the selected payment rail".

## Purpose codes

Payout purpose codes are `S####` codes from a closed, regulator-defined list: https://docs.glomo.one/payout/purpose-codes.md. Payin `P####` codes are rejected on a payout. Choose by purpose group, then description, and collect the documents the list names. If nothing clearly fits, ask the developer; do not pick the nearest-sounding code.

## Status lifecycle

Public statuses: `pending_approval`, `queued`, `in_progress`, `action_required`, `success`, `failed`, `cancelled`.

- `pending_approval`: the account uses maker-checker. A payout created over the API waits here until someone approves it in the dashboard. Nothing is wrong; do not recreate it.
- `queued`: waiting for balance (see below).
- `in_progress`: submitted to the rail, or back under review after an RFI.
- `action_required`: compliance screening did not clear. glomo may raise an RFI (email plus `GET /rfis`). Answer it with `POST /document` and `PATCH /rfis/{id}/respond`. https://docs.glomo.one/request-for-information/handle-rfi-for-a-payout.md
- Terminal: `success`, `failed`, `cancelled`. None of them change again.

A create call can return 201 with the payout already `failed` or `action_required`. Always read the status in the create response.

## Failures: retry, fix, or escalate

Read `error_code` and `error_description` on the payout. A terminal payout is never retried in place. A retry is a **new** payout with a **new** `request_id`, and only after the cause is fixed.

| `error_code` | Meaning | Action |
| --- | --- | --- |
| `INSUFFICIENT_BALANCE` | Balance did not cover source amount + fees | Fund the balance, then create a new payout |
| `QUOTE_EXPIRED` | Quote lapsed before the payout was submitted | New quote, new payout |
| `QUEUE_EXPIRED` | Sat in the queue for 30 days | Fund the balance, then create a new payout |
| `INVALID_BENE_*`, `INVALID_VPA`, `NAME_MISMATCH` | The bank or rail rejected the beneficiary details | Fix the beneficiary (new beneficiary if needed), then a new payout |
| `PAYOUT_REJECTED` | Compliance rejected it after review | Do not retry. Escalate to the developer and glomo support. |

Never auto-retry a payout on a timeout or 5xx with a new `request_id`. Reuse the same `request_id` (a 409 means it exists), or look it up with `GET /payouts?request_id=` first.

## Cancelling

`PATCH /payouts/{id}/cancel` works only before the payout reaches the rail: `pending_approval`, `queued`, `action_required`, and some `in_progress` payouts still under review. Once a payout is with the bank it cannot be cancelled ("Payout cannot be cancelled in its current state"). Do not build a flow that relies on cancelling in-flight payouts. https://docs.glomo.one/payout/cancel.md

## Balances and queued payouts

- A payout debits the merchant's balance in the source currency (`GET /balances`). Funds are held when the payout is submitted and released on failure or cancellation. Fees must be less than the source amount.
- Without payout queueing, a short balance gets a 400 that says how much more is needed.
- With queueing enabled on the account, payouts wait in `queued`. The queue is released roughly hourly, strictly first-in-first-out per currency. One large payout at the head blocks smaller ones behind it. Queued payouts expire after 30 days. https://docs.glomo.one/payout/queued-payouts.md
- Convert between currencies with `POST /balance_conversions`. https://docs.glomo.one/multi-currency-account/balances.md

## Mistakes to avoid

- Leaving out `payment_rail` and paying a domestic beneficiary by SWIFT.
- Creating the payout before the beneficiary is `active`.
- Sending amounts together with `quote_id`.
- Retrying with a fresh `request_id` after a timeout, which pays twice.
- Treating `pending_approval` or `queued` as failures and resubmitting.
- Using a payin purpose code, or inventing one.
