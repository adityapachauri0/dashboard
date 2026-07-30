# Click2Leads — Final Outcome Postback

Post the buying client's **final decision** for each lead you sent us. One HTTP call per
lead per final outcome. Intermediate states (OTP steps, processing) should **not** be posted —
final outcomes only.

## Endpoint

```
POST https://leads.click2leads.co.uk/api/v1/outcomes
Content-Type: application/json
X-API-Key: <your existing Click2Leads API key>
```

Authentication uses the same `X-API-Key` you already use to submit leads to us.
You can only post outcomes for your own leads.

## Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `keycode` | string | **yes** | The lead reference we returned when you submitted the lead (e.g. `KB-2026-000123`) |
| `outcome` | string | **yes** | Final decision: `accepted`, `part_pay`, `full_pay`, `rejected` (case/spacing flexible — `"Full Pay"` is fine). Other final decision values are accepted verbatim. |
| `amount` | number | no | Amount paid for this lead in GBP, e.g. `110`, `39`, `0` |
| `reason` | string | no | Decision detail, e.g. `DUPLICATE_CLIENT`, `KYC_AML_STOP`, `NO_ACCOUNTS_IN_SCOPE` |
| `client` | string | no | Buying client the outcome came from. Defaults to `bluelion` — omit unless told otherwise. |
| `occurred_at` | ISO 8601 datetime | no | When the client issued the decision |

### Example

```bash
curl -X POST https://leads.click2leads.co.uk/api/v1/outcomes \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "keycode": "KB-2026-000123",
    "outcome": "full_pay",
    "amount": 110,
    "occurred_at": "2026-07-31T14:02:11Z"
  }'
```

Rejected example:

```json
{ "keycode": "KB-2026-000124", "outcome": "rejected", "amount": 0, "reason": "NO_ACCOUNTS_IN_SCOPE" }
```

## Responses

| Status | Meaning |
|---|---|
| `200` | Stored. Body: `{ "ref", "client", "outcome", "amount", "updated" }` (`updated: true` = an earlier outcome for this client was overwritten) |
| `400` | Validation error — body `{ "error": "..." }` explains the field |
| `401` | Missing/invalid `X-API-Key` |
| `404` | `keycode` not found (or not one of your leads) |
| `429` | Rate limited (300 requests/min) — retry with backoff |

## Behaviour

- **Idempotent** — re-posting the same outcome for the same lead is safe and changes nothing.
- **Corrections** — post again with the new values; the outcome is updated in place and the
  change is recorded in the lead's audit history.
- **Retries** — on `5xx` or timeout, retry with exponential backoff. Duplicate deliveries are harmless.
