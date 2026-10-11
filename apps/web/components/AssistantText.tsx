import Link from "next/link";
import type { ReactNode } from "react";

/** Turns [label](/path) into links to screens in this app, and **bold** into bold. Anything else stays plain text. */
function rich(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\[([^\]\n]{1,120})\]\((\/[A-Za-z0-9/_?=&%.-]{0,200})\)|\*\*([^*\n]{1,200})\*\*/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > last) parts.push(line.slice(last, match.index));
    if (match[1] !== undefined && match[2] !== undefined && !match[2].startsWith("//")) {
      parts.push(
        <Link key={match.index} href={match[2]} className="row-link">
          {match[1]}
        </Link>,
      );
    } else if (match[3] !== undefined) {
      parts.push(<strong key={match.index}>{match[3]}</strong>);
    } else {
      parts.push(match[0]);
    }
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

export function AssistantText({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index}>
          {paragraph.split("\n").map((line, i) => (
            <span key={i} className="assistant-line">
              {rich(line.replace(/^\s*[-*•]\s+/, "• ").replace(/^#+\s*/, ""))}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}
