import { NextResponse, type NextRequest } from "next/server";

/**
 * The front door. Someone who is not signed in and opens the site's address sees the welcome page;
 * someone signed in goes straight to Home. The address stays "/" either way.
 */
export function proxy(request: NextRequest) {
  if (!request.cookies.get("bos_session")?.value) return NextResponse.rewrite(new URL("/start", request.url));
  return NextResponse.next();
}

export const config = { matcher: "/" };
