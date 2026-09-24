---
name: glomopay-integration
description: Core conventions for building against the glomo (Glomopay) payments API - authentication, sandbox vs live, amounts and IDs, request_id idempotency, error handling and retry decisions, pagination, rate limits, quotes, and where to find the authoritative spec. Use whenever writing, reviewing or debugging code that calls api.glomopay.com, before reaching for the payin, payout, webhook or testing skills.
---

# glomo integration conventions

glomo is a cross-border payments platform. This skill carries the judgement the API reference cannot: how to authenticate, how to tell a retryable failure from a terminal one, and how to avoid creating the same money movement twice. Field-level detail lives in the spec; fetch it rather than guessing.

## Ground truth, in order

1. The OpenAPI description, one self-contained file: https://docs.glomo.one/openapi.yaml (JSON: https://docs.glomo.one/openapi.json). Every `$ref` is resolved. Read the operation you are calling before writing the request. Do not invent fields, enum values or paths.
2. The docs index: https://docs.glomo.one/llms.txt. Append `.md` to any docs URL for markdown.
3. The routing table "what are you building": https://docs.glomo.one/get-started.md

When a value comes from a closed set (purpose codes, rails, currencies, countries, statuses), look it up. A plausible guess is always wrong here and the API rejects it.

## Pick the right skill next

| Building | Skill |
| --- | --- |
| Collecting money: payment links, orders + checkout, S2S cards, subscriptions, LRS, refunds | `glomopay-payins` |
| Sending money: beneficiaries, rails, payouts | `glomopay-payouts` |
| Reacting to status changes | `glomopay-webhooks` |
| Proving it works in sandbox before shipping | `glomopay-testing` |

## Authentication and environments

- Server-side calls send `Authorization: Bearer <secret key>`. The secret key comes from the dashboard, Settings > API Keys. It is shown once; store it in a secret manager, never in source or client code.
- One base URL for both environments: `https://api.glomopay.com/api/v1` (a few resources are under `/api/v2`, for example `/v2/beneficiaries` and `/v2/virtual-accounts`; use the path the spec gives). The key decides the environment: a test key reaches sandbox, a live key reaches production. Do not build a separate sandbox host into config; switch keys.
- The publishable key (`test_...` / `live_...`) is for client SDKs only. Using it on a server call returns 401.
- New accounts start with test keys only. Live keys need glomo to enable live mode.
- If the merchant has an IP allowlist, calls from other IPs get 403. When a correct call returns 403 from a new host, check the allowlist before changing the request.
- Details: https://docs.glomo.one/platform/authentication.md

## Request conventions

- JSON bodies (`Content-Type: application/json`).
- Amounts are integers in minor units (cents, paise, fils). `10000` in USD is $100.00. Never send floats or numeric strings: fields are strictly typed and `"1000"` fails with "must be an integer".
- Currencies are uppercase ISO 4217 codes. Countries are ISO 3166 alpha-3 (`IND`, `USA`, `ARE`). Check https://docs.glomo.one/platform/countries.md for what is supported per direction.
- Timestamps are ISO 8601 in UTC.
- IDs carry a type prefix: `cust_` customer, `order_` order, `plink_` payment link, `payt_` payment, `refund_`, `payout_`, `bene_` beneficiary, `quote_`, `doc_` document, `rfi_`, `sub_` subscription, `setl_` settlement. A wrong prefix in a path is a 404, not a validation error.
- Validation rules the schema cannot express are listed at https://docs.glomo.one/platform/validations.md. The ones that catch agents: customer names allow only letters, digits, spaces and `& . , ' -` (no underscores, no accented letters); customers can only have `email` and `phone` updated after creation; payment link expiry is at most 6 months out.

## Never create the same thing twice: `request_id`

There is no `Idempotency-Key` header. The body field `request_id` does that job on orders, payment links, payments, refunds and payouts. It is unique per merchant.

- Always send one, and derive it from your own record (your order or transfer ID), not a random value generated at call time. A retry must reuse the same `request_id`.
- A repeat `request_id` returns **409** "already exists". The first call succeeded. Do not retry and do not generate a new `request_id`; fetch the existing object (list endpoints accept `?request_id=`).
- Without `request_id` there is no duplicate protection. A retried payout creates a second payout.

Customers have no `request_id`. Uniqueness is on email, so on a create conflict, look the customer up rather than creating a variant.

## Errors: read, then decide

Error bodies are a flat object:

```json
{ "error": "Bad Request", "message": "Validation failed: Name is invalid" }
```

`error` is the HTTP reason phrase; `message` is what to show or log. Some responses carry only `message` (gateway rejections such as 401 and 429) or only `error`. Read `message`, fall back to `error`. There is no stable machine-readable error `code` to switch on; branch on the HTTP status.

| Status | Meaning | Action |
| --- | --- | --- |
| 400 | Invalid input, missing parameter, expired or used quote | Terminal. Fix the request from `message` and the spec. Do not retry unchanged. |
| 401 | Bad, expired or wrong-type key | Terminal. Check which key is in use. |
| 403 | IP allowlist, or a feature not enabled for this account | Terminal. Not fixable in code; see "Account preconditions". |
| 404 | ID does not exist, or belongs to another merchant or environment | Terminal. A sandbox ID does not exist in live. |
| 409 | Duplicate `request_id`, or a record already exists | The first call worked. Fetch it. Exception: "Refund is being processed" is a lock; retry after a short wait. |
| 422 | Request accepted, business outcome failed (FX or bank upstream, refund failed) | Terminal for this request. The body may be the object itself; read its status. |
| 429 | Rate limited | Retry with exponential backoff and jitter. |
| 500 / 502 / 503 / 504 | Server or gateway failure | The outcome of a POST is unknown. Retry only with the same `request_id`, or check first with a `?request_id=` list call. |

Note: https://docs.glomo.one/platform/errors.md shows a nested error object; the flat shape above is what the API returns.

## Account preconditions

A documented, correct call can still fail because something is not enabled for the account: live mode, a payment method, a corridor, payout queueing, partial refunds, LRS. These usually come back as 403 or a 400 whose `message` names a capability rather than a field.

When the request matches the spec and the error names a capability, stop. Do not rewrite the payload or retry variants. Tell the developer which capability the message names and that glomo support enables it.

## Pagination

List endpoints use page numbers, not cursors: `page` (default 1) and `per_page` (default 20, max 100; larger values are clamped to 100, not rejected). `before` / `after` filter on creation time (ISO 8601). Responses are `{ "data": [...], "page_meta": { "current", "previous", "next", "per_page", "pages", "count" } }`. Loop until `page_meta.next` is null. https://docs.glomo.one/platform/pagination.md

## Rate limits

3,000 requests per minute, counted per source IP at the gateway, so several keys behind one NAT share the budget. No rate-limit headers are returned. On 429 back off exponentially. Polling in a tight loop is the usual cause; use webhooks for status (`glomopay-webhooks`).

## Quotes

A quote (`POST /quotes`, `resource: payin` or `payout`) locks the FX rate, fees, rail or payment method, and both amounts. It expires 30 minutes after creation (check `expires_at`) and can be used once.

- Use one when the user must see the exact rate and fee before committing, or to find which rails a payout corridor supports.
- When you pass `quote_id`, do not also send `amount`, `currency`, `payment_methods`, `payment_rail` or `split_ids`; the quote already fixes them and sending them is a 400.
- A payin created from a quote expires when the quote does.
- "Quote has expired" or "Quote has already been used" (400): create a new quote, never reuse one.
- LRS uses its own `POST /lrs/quotes`.
- https://docs.glomo.one/platform/quote.md

## Before you call it done

- Every money-creating call sends a deterministic `request_id`, and 409 is handled as success-already-happened.
- Final status comes from webhooks or a GET, never from the create response alone. Many objects start `in_progress`, `action_required` or `pending`.
- The integration has been run end to end in sandbox (`glomopay-testing`).
- No secret key in client code, logs or error messages.
