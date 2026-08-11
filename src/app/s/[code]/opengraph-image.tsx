import { ImageResponse } from "next/og";
import { getDb } from "@/db";
import { getPublicPourShare } from "@/lib/pour-sharing";

export const runtime = "nodejs";
export const alt = "A shared Whaikey tasting note";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const share = await getPublicPourShare(getDb(), code);
  const title = share?.bottleName ?? "Tasting note";
  const quote = share?.note.freeform ?? share?.note.nose ?? share?.note.palate ?? "A shared moment from a tasting journal.";
  return new ImageResponse(
    <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "#14100b", color: "#f4ecdd", backgroundImage: "radial-gradient(circle at 80% 10%, #5a3513, #14100b 55%)" }}>
      <div style={{ display: "flex", fontSize: 26, letterSpacing: 5, color: "#e8a13c" }}>WHAIKEY · SHARED TASTING NOTE</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        <div style={{ display: "flex", fontSize: 68, fontWeight: 700, lineHeight: 1.05 }}>{title}</div>
        <div style={{ display: "flex", fontSize: 34, lineHeight: 1.35, color: "#d7c6ab" }}>“{quote.slice(0, 220)}”</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: "#a3927a" }}><span>{share ? `${share.ownerName}'s pour` : "Whaikey"}</span><span>whiskey, remembered</span></div>
    </div>,
    size,
  );
}
