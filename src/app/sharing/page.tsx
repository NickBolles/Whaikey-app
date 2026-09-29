import { redirect } from "next/navigation";

/**
 * `/sharing` folded into Settings (WP-11, STORYBOARD §3.7): shared links, the
 * privacy defaults and the moderation notices all live on `/settings` now.
 * Kept as a redirect because it is linked from the journal, share pages,
 * `/responsible`, the share button and every copy of the app shell already
 * installed — and a link somebody saved should still land.
 */
export default function SharingPage() {
  redirect("/settings#sharing");
}
