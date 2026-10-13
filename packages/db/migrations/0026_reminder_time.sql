-- An optional time of day for a reminder, on the company's own clock. Null means any time that day.
alter table reminders add column due_time time;
