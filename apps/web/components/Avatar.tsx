import { avatarGradient } from "../lib/format";

/** Profile pictures are a gradient with no initials. The name is what picks the colours. */
export function Avatar({ name }: { name: string }) {
  return <span className="avatar" aria-hidden="true" style={{ background: avatarGradient(name) }} />;
}
