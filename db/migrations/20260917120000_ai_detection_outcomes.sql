-- Record server-observed language-detection outcomes for Insights reporting.
-- Historical usage rows stay NULL because the provider response was not kept,
-- so classifying those attempts retroactively would invent data.

alter table ai_usage_log
  add column outcome text,
  add column failure_code text;

alter table ai_usage_log
  add constraint ai_usage_log_outcome_check
    check (outcome is null or outcome in ('success', 'indeterminate', 'failure')),
  add constraint ai_usage_log_detection_outcome_check
    check (
      action <> 'detect_language'
      or outcome is null
      or (outcome = 'success' and failure_code is null)
      or (outcome = 'indeterminate' and failure_code in ('empty_response', 'unknown_language', 'unsupported_response'))
      or (outcome = 'failure' and failure_code in ('provider_error', 'insufficient_credit'))
    );

create index ai_usage_log_language_detection_outcomes_idx
  on ai_usage_log (workspace_id, created_at desc)
  where action = 'detect_language' and outcome is not null;

comment on column ai_usage_log.outcome is
  'Server-classified result for reportable AI operations; NULL means the legacy row was not classified.';
comment on column ai_usage_log.failure_code is
  'Stable, non-sensitive reason code for an indeterminate or failed operation.';
