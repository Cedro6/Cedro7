import { redirect } from "next/navigation";

/** Ava used to be a page of her own. She is now on every screen, so this address just goes Home and opens her. */
export default function AssistantPage() {
  redirect("/?ava=open");
}
