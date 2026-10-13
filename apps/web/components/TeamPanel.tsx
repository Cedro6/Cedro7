"use client";

import { useActionState } from "react";
import type { TeamMemberDetail } from "@bos/core";
import { changeMember, invite, newLink, type TeamState } from "../app/(app)/settings/team-actions";

const ROLES = [
  ["owner", "Owner"],
  ["admin", "Admin"],
  ["sales", "Sales"],
  ["purchasing", "Purchasing"],
  ["warehouse", "Warehouse"],
  ["viewer", "View only"],
] as const;
const START: TeamState = { error: "", notice: "", link: "", linkFor: "" };

/** The team list, with invites and one-time sign-in links. A link is shown once, here, for the owner to pass on. */
export function TeamPanel({ members, canMakeOwners }: { members: TeamMemberDetail[]; canMakeOwners: boolean }) {
  const [inviteState, inviteAction, inviting] = useActionState(invite, START);
  const [linkState, linkAction] = useActionState(newLink, START);
  const [changeState, changeAction] = useActionState(changeMember, START);
  const shown = [inviteState, linkState, changeState].find((s) => s.link) ?? null;
  const message = [inviteState, linkState, changeState].find((s) => s.error || s.notice) ?? null;
  const roles = ROLES.filter(([value]) => canMakeOwners || value !== "owner");
  return (
    <>
      <div aria-live="polite">
        {message?.error && <p className="error">{message.error}</p>}
        {message?.notice && !message.error && <p className="notice">{message.notice}</p>}
        {shown && (
          <div className="change link-box">
            <div className="change-label">Sign-in link for {shown.linkFor}</div>
            <p className="muted">
              Send this to them yourself (email, text, however you like). It works once. Anyone who has it can set that person&apos;s password, and it will not be shown again.
            </p>
            <input className="link-field mono" readOnly value={shown.link} aria-label="Sign-in link" onFocus={(event) => event.currentTarget.select()} />
            <button type="button" className="btn btn-glass btn-small" onClick={() => void navigator.clipboard?.writeText(shown.link).catch(() => undefined)}>
              Copy link
            </button>
          </div>
        )}
      </div>
      <div className="rows">
        {members.map((member) => (
          <div className={`row ${member.status === "suspended" ? "is-done" : ""}`} key={member.userId}>
            <div className="row-text">
              <div className="row-title">
                {member.name}
                {member.isYou ? " (you)" : ""}
              </div>
              <div className="muted">
                {member.email} · {member.status === "suspended" ? "Suspended" : member.hasPassword ? "Has a password" : "No password yet"}
                {member.twoStep ? " · Two-step on" : ""}
              </div>
            </div>
            <form action={changeAction} className="inline-form">
              <input type="hidden" name="userId" value={member.userId} />
              <label className="sr-only" htmlFor={`role-${member.userId}`}>
                Role for {member.name}
              </label>
              <select id={`role-${member.userId}`} name="role" defaultValue={member.role} className="select-pill glass" disabled={member.role === "owner" && !canMakeOwners}>
                {ROLES.filter(([value]) => canMakeOwners || value !== "owner" || member.role === "owner").map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn btn-glass btn-small">
                Save
              </button>
              {!member.isYou && (
                <button type="submit" name="status" value={member.status === "active" ? "suspended" : "active"} className="link-button">
                  {member.status === "active" ? "Suspend" : "Reactivate"}
                </button>
              )}
            </form>
            {member.status === "active" && (
              <form action={linkAction}>
                <input type="hidden" name="userId" value={member.userId} />
                <input type="hidden" name="name" value={member.name} />
                <button type="submit" className="link-button">
                  {member.hasPassword ? "Reset password" : "Get sign-in link"}
                </button>
              </form>
            )}
            {member.twoStep && !member.isYou && (
              <form action={changeAction}>
                <input type="hidden" name="userId" value={member.userId} />
                <input type="hidden" name="resetTwoStep" value="1" />
                <button type="submit" className="link-button" title="For someone who lost their phone and recovery codes">
                  Reset two-step
                </button>
              </form>
            )}
          </div>
        ))}
      </div>
      <form action={inviteAction} className="form-row reminder-add">
        <label className="field grow">
          <span>Add a person</span>
          <input name="name" required maxLength={120} placeholder="Full name" />
        </label>
        <label className="field grow">
          <span>Their email</span>
          <input name="email" type="email" required maxLength={200} />
        </label>
        <label className="field">
          <span>Role</span>
          <select name="role" defaultValue="sales">
            {roles.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-glass" disabled={inviting}>
          {inviting ? "Adding…" : "Add"}
        </button>
      </form>
    </>
  );
}
