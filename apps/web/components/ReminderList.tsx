import { clock, type Reminder, type TeamMember } from "@bos/core";
import { addReminder, deleteReminder, toggleReminder } from "../app/(app)/calendar/actions";

const nice = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** Reminders with tick-off and remove, plus a form to add one. Used on the calendar and on a customer's page. */
export function ReminderList({
  reminders,
  team,
  back,
  defaultDate,
  customerId,
  me,
  showCustomer = true,
  empty,
}: {
  reminders: Reminder[];
  team: TeamMember[];
  back: string;
  defaultDate: string;
  customerId?: string;
  me: string;
  showCustomer?: boolean;
  empty: string;
}) {
  return (
    <>
      {reminders.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="rows">
          {reminders.map((reminder) => (
            <div className={`row ${reminder.done ? "is-done" : ""}`} key={reminder.id}>
              <form action={toggleReminder}>
                <input type="hidden" name="id" value={reminder.id} />
                <input type="hidden" name="done" value={reminder.done ? "0" : "1"} />
                <input type="hidden" name="back" value={back} />
                <button type="submit" className="tick" aria-pressed={reminder.done} aria-label={reminder.done ? `Reopen: ${reminder.title}` : `Mark done: ${reminder.title}`}>
                  {reminder.done ? "✓" : ""}
                </button>
              </form>
              <div className="row-text">
                <div className="row-title">{reminder.title}</div>
                <div className="muted">
                  {[`${nice(reminder.dueOn)}${reminder.dueTime ? ` at ${clock(reminder.dueTime)}` : ""}`, showCustomer ? reminder.customerName : null, reminder.assignedName && reminder.assignedTo !== me ? `for ${reminder.assignedName}` : null].filter(Boolean).join(" · ")}
                </div>
              </div>
              {reminder.overdue && <span className="badge badge-warn">Overdue</span>}
              <form action={deleteReminder}>
                <input type="hidden" name="id" value={reminder.id} />
                <input type="hidden" name="back" value={back} />
                <button type="submit" className="link-button" aria-label={`Remove: ${reminder.title}`}>
                  Remove
                </button>
              </form>
            </div>
          ))}
        </div>
      )}
      <form action={addReminder} className="form-row reminder-add">
        <input type="hidden" name="back" value={back} />
        {customerId && <input type="hidden" name="customerId" value={customerId} />}
        <label className="field grow">
          <span>New reminder</span>
          <input name="title" required maxLength={200} placeholder={customerId ? "Call about the next order" : "What needs doing"} />
        </label>
        <label className="field date-field">
          <span>On</span>
          <input name="dueOn" type="date" required defaultValue={defaultDate} />
        </label>
        <label className="field date-field">
          <span>At (optional)</span>
          <input name="dueTime" type="time" />
        </label>
        {team.length > 1 && (
          <label className="field">
            <span>For</span>
            <select name="assignedTo" defaultValue={me}>
              {team.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.id === me ? "Me" : member.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className="btn btn-glass">
          Add
        </button>
      </form>
    </>
  );
}
