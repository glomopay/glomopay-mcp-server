---
name: glomopay-payouts
description: How to send money with the glomo (Glomopay) API - creating and approving v2 beneficiaries, choosing a payout rail (UPI, IMPS, NEFT, RTGS, IPP, FTS, SEPA, FPS, NPP, SWIFT), with-quote vs without-quote payouts, payout purpose codes, the payout status lifecycle, which failures to retry, cancellation rules, queued payouts, balances and RFIs. Use when building or debugging anything that pays a beneficiary.
---

# glomo payouts

Read `glomopay-integration` first for auth, amounts, `request_id` and error handling. A payout moves real money, so the rules here are about never paying twice and never retrying a failure that needs a human. Take field shapes from https://docs.glomo.one/openapi.yaml.

## Ordered sequence

1. **Beneficiary**: `POST /v2/beneficiaries` with `category: payout`. Store the `bene_` ID. There is no v1 beneficiary API.
2. **Wait until the beneficiary is `active`.** If the account reviews beneficiaries, new ones start `pending` and move to `active` or `rejected` (`beneficiary` webhook, or `GET /v2/beneficiaries/{id}`). Other accounts create them `active` straight away. A payout create against a `pending` or `rejected` beneficiary is refused with 400 ("verification is pending" / "has been rejected") and no payout is created.
3. **Documents** if the purpose code needs them: `POST /document`, then pass the `doc_` IDs in the payout's `documents`.
4. **Quote** (optional): `POST /quotes` with `resource: payout` and `payment_method: {type: "bank_transfer", subtype: "local_transfer" | "swift_transfer"}`. It returns one option per rail of that subtype whose limits fit the amount, valid 30 minutes and usable once. It does not look at the beneficiary, so a quoted rail may still not suit this beneficiary: the payout is then a 400 "quote_id is not compatible with the selected beneficiary".
5. **Payout**: `POST /payouts` with a deterministic `request_id`.
6. **Outcome**: `payout` webhooks, with `GET /payouts/{id}` or `GET /payouts?request_id=` to reconcile.

Guide: https://docs.glomo.one/payout/create.md. Lifecycle: https://docs.glomo.one/payout/life-cycle.md

## With or without a quote

- **With `quote_id`**: the quote fixes amounts, currencies and rail. Do not send `source_amount`, `destination_amount`, `source_currency`, `destination_currency` or `payment_rail` as well; that is a 400. Use this when the user must approve the exact rate and fee.
- **Without a quote**: send the amounts, currencies and `payment_rail` yourself; glomo prices it at creation. Simpler for known corridors.
- LRS repatriation payouts (USD to INR back to an investor) cannot use a quote. Follow https://docs.glomo.one/payin/resident-india-remittance-under-lrs/set-up/withdrawal-flow-guide.md

## Choosing the rail

**Always set `payment_rail`.** If you omit it, glomo uses SWIFT. That only works for beneficiaries with SWIFT details (a BIC, or an AED or EUR IBAN). Anyone else, such as an INR beneficiary with IFSC or UPI, or a GBP beneficiary with only a sort code, gets 400 "No rails available for this beneficiary". Where SWIFT does work, you pay SWIFT fees and wait SWIFT times when a local rail was available.

| Destination | Rails | Beneficiary needs |
| --- | --- | --- |
| INR | `upi`, `imps`, `neft`, `rtgs` | Account number + IFSC in `local_routing_number`, or a UPI ID for `upi` |
| AED | `ipp` (up to AED 50,000), `fts` | IBAN |
| EUR | `sepa` | IBAN |
| GBP | `fps` | Domestic account number + sort code. A GB IBAN alone does not qualify for `fps`. |
| AUD | `npp` | BSB + domestic account number. Not yet in the spec's `payment_rail` enum; confirm it is available for the account before relying on it. |
| Anything else | `swift` | Account number + `swift_code` (BIC); the BIC country must match the bank address country |

Per-rail limits and details: https://docs.glomo.one/payout/rails.md. Only use rail values from that page, the spec enum and the table above.

- A beneficiary is eligible for a rail only if it holds that rail's identifiers. Collect them when you create the beneficiary.
- SWIFT payouts are processed manually and are slower than local rails.
- UPI and IMPS run 24x7; NEFT and RTGS follow Indian bank working days; SWIFT follows FX business days. Check https://docs.glomo.one/multi-currency-account/settlement-holidays.md before promising a date.
- For INR local rails, the purpose code must also be valid for the rail, or you get "not a valid purpose code for the selected payment rail".

## Purpose codes

Payout purpose codes come from a closed, regulator-defined list: https://docs.glomo.one/payout/purpose-codes.md. They are mostly `S####` codes; payin `P####` codes are rejected on a payout. LRS flows are the exception: an LRS repatriation payout uses `P0001`, and the LRS guide names the codes for its other payouts. Choose by purpose group, then description, and collect the documents the list names. If nothing clearly fits, ask the developer; do not pick the nearest-sounding code.

## Status lifecycle

Public statuses: `pending_approval`, `queued`, `in_progress`, `action_required`, `success`, `failed`, `cancelled`.

- `pending_approval`: the account uses maker-checker. A payout created over the API waits here until someone approves it in the dashboard. Nothing is wrong; do not recreate it.
- `queued`: waiting for balance (see below).
- `in_progress`: submitted to the rail, or back under review after an RFI.
- `action_required`: compliance screening did not clear. glomo may raise an RFI (email, and `GET /rfis`; the payout response does not carry the RFI ID). Answer it with `POST /document` and `PATCH /rfis/{id}/respond`. https://docs.glomo.one/request-for-information/handle-rfi-for-a-payout.md
- Terminal: `success`, `failed`, `cancelled`. None of them change again.

A create call returns 201 even when the payout is already `failed` or `action_required`. Always read the status in the create response.

## Failures: retry, fix, or escalate

Read `error_code` and `error_description` on the payout. A terminal payout is never retried in place. A retry is a **new** payout with a **new** `request_id`, and only after the cause is fixed.

| `error_code` | Meaning | Action |
| --- | --- | --- |
| `INSUFFICIENT_BALANCE` | Balance did not cover source amount + fees | Fund the balance, then create a new payout |
| `QUOTE_EXPIRED` | Quote lapsed before the payout was submitted | New quote, new payout |
| `QUEUE_EXPIRED` | Sat in the queue for 30 days | Fund the balance, then create a new payout |
| `INVALID_BENE_*`, `INVALID_VPA`, `NAME_MISMATCH` | The bank or rail rejected the beneficiary details | Fix the beneficiary (new beneficiary if needed), then a new payout |
| `PAYOUT_REJECTED` | Rejected by compliance after review (ends `cancelled`), or by the bank for a reason glomo does not map (ends `failed`) | Do not retry. Escalate to the developer and glomo support. |
| none, on a `failed` payout at creation | Compliance screening could not run | Retry once later with a new `request_id`; escalate if it repeats |

Never auto-retry a payout on a timeout or 5xx with a new `request_id`. Reuse the same `request_id` (a 409 means it exists), or look it up with `GET /payouts?request_id=` first.

## Cancelling

`PATCH /payouts/{id}/cancel` works only before the payout reaches the rail: `pending_approval`, `queued`, `action_required`, and `in_progress` payouts still under compliance review. Once a payout is with the bank it cannot be cancelled ("Payout cannot be cancelled in its current state"). Do not build a flow that relies on cancelling in-flight payouts. https://docs.glomo.one/payout/cancel.md

## Balances and queued payouts

- A payout debits the merchant's balance in the source currency (`GET /balances`). Funds are held once screening clears and the payout is released for processing (on accounts without queueing or maker-checker, that happens inside the create call). Nothing is held while a payout is `pending_approval`, `queued`, `action_required` or under review. Holds are released on failure or cancellation. Fees must be less than the source amount.
- Without payout queueing, a short balance is a 400 with `code: INSUFFICIENT_BALANCE` and a message stating the additional amount required.
- With queueing enabled on the account, payouts wait in `queued` and are screened on release. The queue is released every 15 minutes, strictly first-in-first-out per currency. One large payout at the head blocks smaller ones behind it. Queued payouts expire after 30 days. https://docs.glomo.one/payout/queued-payouts.md
- Convert between currencies with `POST /balance_conversions`. https://docs.glomo.one/multi-currency-account/balances.md

## Mistakes to avoid

- Leaving out `payment_rail`: a 400 for most domestic beneficiaries, or an avoidable SWIFT payout for the rest.
- Creating the payout before the beneficiary is `active`.
- Sending amounts together with `quote_id`, or assuming a quoted rail suits the beneficiary.
- Retrying with a fresh `request_id` after a timeout, which pays twice.
- Treating `pending_approval` or `queued` as failures and resubmitting.
- Using a payin purpose code, or inventing one.
