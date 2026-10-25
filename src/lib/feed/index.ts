import type { FriendFeedItem } from "@/components/friends-module";
import type { FeedItem } from "@/lib/social";

/**
 * The feed's wire shape (docs/SOCIAL.md §7.3): exactly the fields a card
 * renders. `visibility` and anything about the author beyond their public
 * identity stay server-side; money and volume columns never reach `FeedItem`
 * in the first place.
 */
export function toFeedItemJson(f: FeedItem, matches: Map<string, number>): FriendFeedItem {
  return {
    pourId: f.pourId,
    bottleId: f.bottleId,
    bottleName: f.bottleName,
    author: f.author,
    rating: f.rating,
    servingStyle: f.servingStyle,
    createdAt: f.createdAt.toISOString(),
    nose: f.nose,
    palate: f.palate,
    finish: f.finish,
    freeform: f.freeform,
    flavorTags: f.flavorTags,
    cheersCount: f.cheersCount,
    commentCount: f.commentCount,
    viewerCheered: f.viewerCheered,
    viewerTags: f.viewerTags,
    viewerBottleRelationship: f.viewerBottleRelationship,
    palateMatchPercent: matches.get(f.author.userId) ?? null,
  };
}
