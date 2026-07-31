// Upsert one buying client's final outcome on a lead (+ audit history entry).
// Shared by the /outcomes endpoint and the platform webhook so integrators can
// send commercials on either. Values must be pre-validated/canonical;
// amount/reason/occurred_at === undefined means keep the existing value.
const canon = (v) => String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');

function applyClientOutcome(lead, { client, outcome, amount, reason, occurred_at }, { source }) {
  const now = new Date();
  const existing = lead.client_outcomes.find((o) => o.client === client);
  const summarise = (o) => (o ? `${o.outcome}${o.amount ? ` £${o.amount}` : ''}` : null);
  const next = {
    client,
    outcome,
    reason: reason !== undefined ? reason : existing?.reason,
    amount: amount !== undefined ? amount : existing?.amount ?? 0,
    occurred_at: occurred_at !== undefined ? occurred_at : existing?.occurred_at,
    received_at: now,
  };
  const changed =
    !existing || summarise(existing) !== summarise(next) || (existing.reason || '') !== (next.reason || '');
  if (changed) {
    lead.history.push({
      at: now,
      field: `client_outcome:${client}`,
      from: summarise(existing),
      to: summarise(next),
      source,
    });
  }
  if (existing) Object.assign(existing, next);
  else lead.client_outcomes.push(next);
  return { changed, next };
}

module.exports = { applyClientOutcome, canon };
