-- Putaway: a received line is ticked off once it has been moved from the dock to its shelf.
-- The receipt itself stays a posted document; only these two columns may change.
alter table receipt_lines
  add column put_away_at timestamptz,
  add column put_away_by uuid references users (id);

-- Everything received before this feature existed counts as already put away.
update receipt_lines set put_away_at = now() where put_away_at is null;

grant update (put_away_at, put_away_by) on receipt_lines to bos_app;
