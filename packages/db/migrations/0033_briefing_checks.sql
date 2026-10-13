-- Each briefing point links one record. The state of that record when the briefing was written is
-- kept here, so the point can cross itself off once the record has moved on (shipped, received, paid, restocked).
alter table assistant_briefings add column if not exists checks jsonb not null default '[]'::jsonb;
