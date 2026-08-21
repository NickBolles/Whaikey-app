import type { ReactElement } from "react";
import type { PassportFamily } from "@/db/schema";
import { tierSpec } from "@/lib/passport-tiers";

/**
 * The Passport's badge crests (docs/FEATURES.md §11.4), pure SVG so they
 * render server-side and stay crisp at every size. Three families, told
 * apart by silhouette: countries are shields carrying a flag treatment,
 * regions are struck coins with an engraved motif, styles are cask-end
 * hexagons in brass line-work. The frame's metal is the tier
 * (oak → copper → silver → gold → amber); tier V adds laurels.
 *
 * Values without bespoke art (a new region, a future country) fall back to a
 * monogram die automatically, so the open sets never break. Numbers shown
 * anywhere here are DISTINCT bottles met — never pours (docs/SOCIAL.md §3.2).
 */

const CREAM = "#f2ead8";
const INK = "#14100b";
const GOLD = "#e8a13c";
const GOLD_DEEP = "#8a5a14";
const FIELD_BG = "#241c11";
const STYLE_BG = "#231b10";

interface TierMetal {
  ring0: string;
  ring1: string;
  edge: string;
  text: string;
}

const TIER_METALS: Record<number, TierMetal> = {
  1: { ring0: "#7d5f3c", ring1: "#4a3823", edge: "#95744c", text: "#e8d7b8" },
  2: { ring0: "#d18a54", ring1: "#7c4322", edge: "#e59d66", text: "#f8dfc9" },
  3: { ring0: "#dde2e7", ring1: "#79848f", edge: "#f2f5f8", text: "#212830" },
  4: { ring0: "#f5cf70", ring1: "#9c6a12", edge: "#ffe8a3", text: "#3a2a06" },
  5: { ring0: "#ffdd85", ring1: "#b96f1e", edge: "#fff0bb", text: "#3a2a06" },
};

function starPoints(cx: number, cy: number, outer: number, inner: number, points: number, rotate = -90): string {
  const parts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((rotate + (180 * i) / points) * Math.PI) / 180;
    parts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return parts.join(" ");
}

function polygonPoints(cx: number, cy: number, r: number, sides: number, rotate = -90): string {
  const parts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = ((rotate + (360 * i) / sides) * Math.PI) / 180;
    parts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return parts.join(" ");
}

const SHIELD_OUTER = "M36 4 L63 11 V37 C63 53 52 64 36 72 C20 64 9 53 9 37 V11 Z";
const SHIELD_INNER = "M36 9.5 L58.5 15.2 V36.5 C58.5 49.8 49.2 59.4 36 66.4 C22.8 59.4 13.5 49.8 13.5 36.5 V15.2 Z";
const HEX_OUTER = polygonPoints(36, 38, 31.5, 6);
const HEX_INNER = polygonPoints(36, 38, 25.5, 6);
const HEX_DETAIL = polygonPoints(36, 38, 28.5, 6);

/** Fills the emblem clip generously; the frame's clipPath crops it. */
const FIELD = { x: 6, y: 4, width: 60, height: 66 } as const;

// ---------------------------------------------------------------------------
// Country emblems — faithful-but-simplified flag treatments
// ---------------------------------------------------------------------------

function ScotlandEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#1d4a80" />
      <g stroke={CREAM} strokeWidth={7}>
        <line x1={10} y1={10} x2={62} y2={60} />
        <line x1={62} y1={10} x2={10} y2={60} />
      </g>
      {/* Engraved thistle: crown, bulb, leaves. */}
      <path
        d="M29 27 L31.8 33.5 L36 30.5 L40.2 33.5 L43 27 L44.5 34 Q45 38 41.5 39.5 L30.5 39.5 Q27 38 27.5 34 Z"
        fill={GOLD}
        stroke={GOLD_DEEP}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      <path d="M30.5 39.5 q5.5 -3.2 11 0 q1.6 7 -5.5 10.5 q-7.1 -3.5 -5.5 -10.5 z" fill={GOLD} stroke={GOLD_DEEP} strokeWidth={1} />
      <g stroke={GOLD_DEEP} strokeWidth={0.9} opacity={0.85}>
        <line x1={32.2} y1={41} x2={39.2} y2={47.5} />
        <line x1={39.8} y1={41} x2={32.8} y2={47.5} />
        <line x1={36} y1={40} x2={36} y2={49} />
      </g>
      <path d="M29 52 q-5 .5 -7.5 4.5 q5.5 1 8.5 -3 z" fill={GOLD} />
      <path d="M43 52 q5 .5 7.5 4.5 q-5.5 1 -8.5 -3 z" fill={GOLD} />
      <line x1={36} y1={50} x2={36} y2={57} stroke={GOLD} strokeWidth={1.7} />
    </>
  );
}

function UsaEmblem(): ReactElement {
  const stripes = Array.from({ length: 7 }, (_, i) => (
    <rect key={i} x={6 + i * 8.6} y={22} width={8.6} height={48} fill={i % 2 ? CREAM : "#b3342e"} />
  ));
  return (
    <>
      {stripes}
      <rect x={6} y={4} width={60} height={18} fill="#22335c" />
      {[19, 36, 53].map((x) => (
        <polygon key={x} points={starPoints(x, 13, 3.4, 1.35, 5)} fill={CREAM} />
      ))}
      <polygon points={starPoints(36, 42, 10, 4, 5)} fill={GOLD} stroke={GOLD_DEEP} strokeWidth={1} />
    </>
  );
}

function IrelandEmblem(): ReactElement {
  return (
    <>
      <rect x={6} y={4} width={20} height={66} fill="#169b62" />
      <rect x={26} y={4} width={20} height={66} fill={CREAM} />
      <rect x={46} y={4} width={20} height={66} fill="#e07a3f" />
      <g stroke={GOLD} strokeWidth={2.2} fill="none" strokeLinecap="round">
        <path d="M31 24 q-7.5 12 1.5 25 l10.5 -4 q-5.5 -10 .5 -21 z" fill="rgba(20,16,11,.35)" />
        <line x1={34.5} y1={29} x2={36.3} y2={44.5} />
        <line x1={38} y1={27.5} x2={39.6} y2={43} />
        <line x1={41.2} y1={26} x2={42.6} y2={41.5} />
      </g>
    </>
  );
}

function JapanEmblem(): ReactElement {
  const rays = Array.from({ length: 12 }, (_, i) => {
    const a = (i * 30 * Math.PI) / 180;
    return (
      <line
        key={i}
        x1={(36 + 14.5 * Math.cos(a)).toFixed(1)}
        y1={(34 + 14.5 * Math.sin(a)).toFixed(1)}
        x2={(36 + 19 * Math.cos(a)).toFixed(1)}
        y2={(34 + 19 * Math.sin(a)).toFixed(1)}
      />
    );
  });
  return (
    <>
      <rect {...FIELD} fill={CREAM} />
      <g stroke={GOLD} strokeWidth={1.8} strokeLinecap="round">
        {rays}
      </g>
      <circle cx={36} cy={34} r={11} fill="#bc3a35" />
    </>
  );
}

const MAPLE_LEAF =
  "M36 22 L38.6 27.4 L43.5 25.6 L41.8 31 L47.5 32 L43.2 36.4 L45.8 41 L38.8 39.8 L38.8 48 L33.2 48 L33.2 39.8 L26.2 41 L28.8 36.4 L24.5 32 L30.2 31 L28.5 25.6 L33.4 27.4 Z";

function CanadaEmblem(): ReactElement {
  return (
    <>
      <rect x={6} y={4} width={14} height={66} fill="#c0392e" />
      <rect x={52} y={4} width={14} height={66} fill="#c0392e" />
      <rect x={20} y={4} width={32} height={66} fill={CREAM} />
      <path fill="#c0392e" d={MAPLE_LEAF} />
    </>
  );
}

function IndiaEmblem(): ReactElement {
  const spokes = Array.from({ length: 12 }, (_, i) => {
    const a = (i * 30 * Math.PI) / 180;
    return <line key={i} x1={36} y1={33} x2={(36 + 7.4 * Math.cos(a)).toFixed(1)} y2={(33 + 7.4 * Math.sin(a)).toFixed(1)} />;
  });
  return (
    <>
      <rect x={6} y={4} width={60} height={20} fill="#e1913a" />
      <rect x={6} y={24} width={60} height={19} fill={CREAM} />
      <rect x={6} y={43} width={60} height={27} fill="#2c6e3f" />
      <circle cx={36} cy={33} r={8} fill="none" stroke="#27408b" strokeWidth={1.6} />
      <g stroke="#27408b" strokeWidth={0.9}>
        {spokes}
      </g>
      <circle cx={36} cy={33} r={1.5} fill="#27408b" />
    </>
  );
}

function TaiwanEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#b8322f" />
      <circle cx={36} cy={34} r={12.5} fill="#1e3f8f" />
      <polygon points={starPoints(36, 34, 9, 4.2, 12)} fill={CREAM} />
      <circle cx={36} cy={34} r={3.6} fill="#1e3f8f" />
      <circle cx={36} cy={34} r={2.7} fill={CREAM} />
    </>
  );
}

function AustraliaEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#1c2b57" />
      <polygon points={starPoints(26, 42, 7.5, 3.4, 7)} fill={GOLD} />
      {(
        [
          [47, 17, 3.2],
          [53, 28, 2.7],
          [47, 45, 3.2],
          [41, 30, 2.3],
          [51, 36, 1.9],
        ] as const
      ).map(([x, y, r]) => (
        <polygon key={`${x}-${y}`} points={starPoints(x, y, r, r * 0.44, 7)} fill={CREAM} />
      ))}
    </>
  );
}

function WalesEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#181209" />
      <rect x={31.5} y={4} width={9} height={66} fill={GOLD} />
      <rect x={6} y={29.5} width={60} height={9} fill={GOLD} />
      <rect x={31.5} y={29.5} width={9} height={9} fill="#ffd77e" />
    </>
  );
}

// ---------------------------------------------------------------------------
// Region emblems — engraved coin motifs
// ---------------------------------------------------------------------------

function Barley({ cx, topY, h, color = GOLD }: { cx: number; topY: number; h: number; color?: string }): ReactElement {
  const grains: ReactElement[] = [];
  for (let i = 0; i < 4; i++) {
    const y = topY + 3 + i * 4.2;
    grains.push(
      <ellipse key={`l${i}`} cx={cx - 2.6} cy={y} rx={1.7} ry={2.6} fill={color} transform={`rotate(-28 ${cx - 2.6} ${y})`} />,
      <ellipse key={`r${i}`} cx={cx + 2.6} cy={y} rx={1.7} ry={2.6} fill={color} transform={`rotate(28 ${cx + 2.6} ${y})`} />,
    );
  }
  return (
    <>
      <line x1={cx} y1={topY} x2={cx} y2={topY + h} stroke={color} strokeWidth={1.4} />
      {grains}
      <g stroke={color} strokeWidth={0.9}>
        <line x1={cx} y1={topY} x2={cx - 3.5} y2={topY - 5} />
        <line x1={cx} y1={topY} x2={cx} y2={topY - 6} />
        <line x1={cx} y1={topY} x2={cx + 3.5} y2={topY - 5} />
      </g>
    </>
  );
}

function IslayEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#22333a" />
      <g fill="none" strokeLinecap="round">
        <path d="M22 47 q4.5 -5 9 0 q4.5 5 9 0 q4.5 -5 9 0" stroke={CREAM} strokeWidth={2} />
        <path d="M24 53 q4 -4.5 8 0 q4 4.5 8 0 q4 -4.5 8 0" stroke={CREAM} strokeWidth={1.5} opacity={0.65} />
        <path d="M34 42 q7 -4 1.5 -10 q-5.5 -6 2 -11" stroke={GOLD} strokeWidth={2.2} />
        <path d="M41 39 q4.5 -3 1 -7" stroke={GOLD} strokeWidth={1.5} opacity={0.75} />
      </g>
    </>
  );
}

function SpeysideEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#20321f" />
      <path d="M27 55 q10 -7 -1 -13 q-11 -6 2 -13 q9 -5 4 -9" fill="none" stroke="#a9c6d8" strokeWidth={2.6} strokeLinecap="round" />
      <Barley cx={45} topY={31} h={17} />
    </>
  );
}

function HighlandEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#2b2033" />
      <circle cx={27} cy={26} r={4} fill={GOLD} />
      <path d="M17 52 L27 36 L33 44 L41 28 L55 52 Z" fill="none" stroke={CREAM} strokeWidth={2.2} strokeLinejoin="round" />
      <path d="M37 36 L41 42 L45 36" fill="none" stroke={CREAM} strokeWidth={1.3} opacity={0.7} />
    </>
  );
}

function LowlandEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#243218" />
      <Barley cx={27} topY={31} h={19} />
      <Barley cx={36} topY={26} h={22} />
      <Barley cx={45} topY={31} h={19} />
    </>
  );
}

function CampbeltownEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#1d2a3c" />
      <g stroke={GOLD} strokeWidth={1.4} strokeLinecap="round">
        <line x1={28} y1={24} x2={21} y2={20} />
        <line x1={44} y1={24} x2={51} y2={20} />
        <line x1={36} y1={21} x2={36} y2={15} />
      </g>
      <rect x={32.6} y={22} width={6.8} height={5} fill={CREAM} />
      <path d="M31.5 51 L33.2 27 H38.8 L40.5 51 Z" fill={CREAM} />
      <g stroke="#1d2a3c" strokeWidth={1.2}>
        <line x1={32.7} y1={33} x2={39.3} y2={33} />
        <line x1={32.3} y1={40} x2={39.7} y2={40} />
      </g>
      <path d="M22 54 q4.5 -4 9 0 q4.5 4 9 0 q4.5 -4 9 0" fill="none" stroke="#a9c6d8" strokeWidth={1.7} strokeLinecap="round" />
    </>
  );
}

function IslandsEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#20303a" />
      <circle cx={36} cy={38} r={14} fill="none" stroke={CREAM} strokeWidth={1.2} opacity={0.7} />
      <polygon points={starPoints(36, 38, 16, 2.4, 4)} fill={GOLD} />
      <polygon points={starPoints(36, 38, 9, 2, 4, -45)} fill={CREAM} />
      <circle cx={36} cy={38} r={2.2} fill="#20303a" stroke={GOLD} strokeWidth={1} />
    </>
  );
}

function KentuckyEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#2e1c0f" />
      <circle cx={36} cy={38} r={14.5} fill="#3a2413" stroke={GOLD} strokeWidth={2} />
      <circle cx={36} cy={38} r={10.5} fill="none" stroke={GOLD} strokeWidth={0.9} opacity={0.7} />
      <g stroke={GOLD} strokeWidth={0.9} opacity={0.55}>
        <line x1={29} y1={25.5} x2={29} y2={50.5} />
        <line x1={36} y1={23.5} x2={36} y2={52.5} />
        <line x1={43} y1={25.5} x2={43} y2={50.5} />
      </g>
      <polygon points={starPoints(36, 38, 5.2, 2.2, 5)} fill={GOLD} />
    </>
  );
}

function TennesseeEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#6e2230" />
      <circle cx={36} cy={38} r={13.5} fill="#243447" stroke={CREAM} strokeWidth={1.6} />
      <polygon points={starPoints(36, 31.5, 4, 1.7, 5)} fill={CREAM} />
      <polygon points={starPoints(30.5, 41, 4, 1.7, 5, -162)} fill={CREAM} />
      <polygon points={starPoints(41.5, 41, 4, 1.7, 5, -18)} fill={CREAM} />
    </>
  );
}

function TexasEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill="#1d2b47" />
      <circle cx={36} cy={38} r={15} fill="none" stroke={GOLD} strokeWidth={1.3} opacity={0.8} />
      <polygon points={starPoints(36, 38, 11.5, 4.8, 5)} fill={CREAM} stroke={GOLD} strokeWidth={1} />
    </>
  );
}

/** The auto-minted die for any value without bespoke art. */
function MonogramEmblem({ letter }: { letter: string }): ReactElement {
  return (
    <>
      <rect {...FIELD} fill={FIELD_BG} />
      <circle cx={36} cy={38} r={15} fill="none" stroke={GOLD_DEEP} strokeWidth={1} />
      <text
        x={36}
        y={46}
        textAnchor="middle"
        fontFamily="var(--font-fraunces), Georgia, serif"
        fontWeight={600}
        fontSize={24}
        fill={GOLD}
      >
        {letter}
      </text>
    </>
  );
}

// ---------------------------------------------------------------------------
// Style emblems — brass line-work on the cask-end
// ---------------------------------------------------------------------------

const LINE = { fill: "none", stroke: GOLD, strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function BourbonEmblem(): ReactElement {
  const kernels: ReactElement[] = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 2; c++) {
      kernels.push(<circle key={`${r}-${c}`} cx={33.5 + c * 5} cy={26 + r * 5.4} r={1.6} fill={GOLD} />);
    }
  }
  return (
    <>
      <rect {...FIELD} fill={STYLE_BG} />
      <path d="M36 18 q-8.5 3 -8.5 17 q0 12 8.5 17 q8.5 -5 8.5 -17 q0 -14 -8.5 -17 z" {...LINE} />
      <path d="M27.5 38 q-6 4 -7 12 q7 -1 10.5 -6.5" {...LINE} strokeWidth={1.3} />
      <path d="M44.5 38 q6 4 7 12 q-7 -1 -10.5 -6.5" {...LINE} strokeWidth={1.3} />
      {kernels}
    </>
  );
}

function RyeEmblem(): ReactElement {
  const awns: ReactElement[] = [];
  for (let i = 0; i < 4; i++) {
    const y = 24 + i * 4.4;
    awns.push(
      <line key={`l${i}`} x1={33.5} y1={y} x2={27} y2={y - 8} stroke={GOLD} strokeWidth={0.9} />,
      <line key={`r${i}`} x1={38.5} y1={y} x2={45} y2={y - 8} stroke={GOLD} strokeWidth={0.9} />,
    );
  }
  return (
    <>
      <rect {...FIELD} fill={STYLE_BG} />
      {awns}
      <Barley cx={36} topY={22} h={20} />
      <path d="M36 42 q-4 6 -1 12" {...LINE} strokeWidth={1.3} />
    </>
  );
}

function AmericanSingleMaltEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill={STYLE_BG} />
      <polygon points={starPoints(36, 19, 4.4, 1.9, 5)} fill={GOLD} />
      <Barley cx={36} topY={29} h={18} />
    </>
  );
}

function AmericanOtherEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill={STYLE_BG} />
      <path d="M36 18 L50 22 V36 C50 45 44 51 36 55 C28 51 22 45 22 36 V22 Z" {...LINE} />
      <polygon points={starPoints(36, 32, 5.5, 2.4, 5)} fill={GOLD} />
      <g stroke={GOLD} strokeWidth={1.1}>
        <line x1={28} y1={42} x2={44} y2={42} />
        <line x1={30} y1={46} x2={42} y2={46} />
      </g>
    </>
  );
}

function ScotchSingleMaltEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill={STYLE_BG} />
      <path d="M27.5 52 Q25 42.5 32 40 H40 Q47 42.5 44.5 52" {...LINE} />
      <path d="M33.5 40 V35 Q33.5 31 36.6 31 Q39.8 31 39.8 35 V36.5" {...LINE} />
      <path d="M39.8 33.8 Q46.5 31.5 50 37 Q52.5 41.5 52.5 52" {...LINE} />
      <line x1={24} y1={52} x2={55} y2={52} stroke={GOLD} strokeWidth={1.7} strokeLinecap="round" />
    </>
  );
}

function ScotchBlendedEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill={STYLE_BG} />
      <path d="M25 32 h22 q-1.5 12 -11 13.5 q-9.5 -1.5 -11 -13.5 z" {...LINE} />
      <path d="M25 33.5 h-6 v4 h6.8 M47 33.5 h6 v4 h-6.8" {...LINE} strokeWidth={1.3} />
      <path d="M31 50 h10 M33 45.5 l0 4.5 M39 45.5 l0 4.5" {...LINE} strokeWidth={1.3} />
    </>
  );
}

function IrishEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill={STYLE_BG} />
      <g fill={GOLD}>
        <circle cx={36} cy={26.5} r={5.2} />
        <circle cx={30} cy={35.5} r={5.2} />
        <circle cx={42} cy={35.5} r={5.2} />
      </g>
      <circle cx={36} cy={32.5} r={3.4} fill={STYLE_BG} />
      <path d="M36 38 q-2 8 2 13" {...LINE} strokeWidth={1.4} />
    </>
  );
}

function JapaneseEmblem(): ReactElement {
  const petals = Array.from({ length: 5 }, (_, i) => {
    const a = -90 + i * 72;
    const rad = (a * Math.PI) / 180;
    const x = Number((36 + 7.6 * Math.cos(rad)).toFixed(1));
    const y = Number((36 + 7.6 * Math.sin(rad)).toFixed(1));
    return (
      <ellipse key={i} cx={x} cy={y} rx={4.4} ry={6.6} fill="none" stroke={GOLD} strokeWidth={1.5} transform={`rotate(${a + 90} ${x} ${y})`} />
    );
  });
  return (
    <>
      <rect {...FIELD} fill={STYLE_BG} />
      {petals}
      <circle cx={36} cy={36} r={2.4} fill={GOLD} />
    </>
  );
}

function CanadianEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill={STYLE_BG} />
      <path d={MAPLE_LEAF} fill="none" stroke={GOLD} strokeWidth={1.6} strokeLinejoin="round" />
      <line x1={36} y1={48} x2={36} y2={53} stroke={GOLD} strokeWidth={1.6} strokeLinecap="round" />
    </>
  );
}

function WorldEmblem(): ReactElement {
  return (
    <>
      <rect {...FIELD} fill={STYLE_BG} />
      <circle cx={36} cy={36} r={14} {...LINE} />
      <ellipse cx={36} cy={36} rx={6.5} ry={14} {...LINE} strokeWidth={1.2} />
      <line x1={22} y1={36} x2={50} y2={36} stroke={GOLD} strokeWidth={1.2} />
      <path d="M24.5 28.5 q11.5 4 23 0 M24.5 43.5 q11.5 -4 23 0" {...LINE} strokeWidth={1.2} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Emblem registries
// ---------------------------------------------------------------------------

const COUNTRY_EMBLEMS: Record<string, () => ReactElement> = {
  Scotland: ScotlandEmblem,
  USA: UsaEmblem,
  Ireland: IrelandEmblem,
  Japan: JapanEmblem,
  Canada: CanadaEmblem,
  India: IndiaEmblem,
  Taiwan: TaiwanEmblem,
  Australia: AustraliaEmblem,
  Wales: WalesEmblem,
};

const REGION_EMBLEMS: Record<string, () => ReactElement> = {
  Islay: IslayEmblem,
  Speyside: SpeysideEmblem,
  Highland: HighlandEmblem,
  Lowland: LowlandEmblem,
  Campbeltown: CampbeltownEmblem,
  Islands: IslandsEmblem,
  Kentucky: KentuckyEmblem,
  Tennessee: TennesseeEmblem,
  Texas: TexasEmblem,
};

const STYLE_EMBLEMS: Record<string, () => ReactElement> = {
  bourbon: BourbonEmblem,
  rye: RyeEmblem,
  "american-single-malt": AmericanSingleMaltEmblem,
  "american-other": AmericanOtherEmblem,
  "scotch-single-malt": ScotchSingleMaltEmblem,
  "scotch-blended": ScotchBlendedEmblem,
  irish: IrishEmblem,
  japanese: JapaneseEmblem,
  canadian: CanadianEmblem,
  world: WorldEmblem,
};

/** Exposed so tests can assert every seeded value resolves to bespoke art. */
export function hasBespokeEmblem(family: PassportFamily, value: string): boolean {
  const registry = family === "country" ? COUNTRY_EMBLEMS : family === "region" ? REGION_EMBLEMS : STYLE_EMBLEMS;
  return value in registry;
}

function Emblem({ family, value }: { family: PassportFamily; value: string }): ReactElement {
  const registry = family === "country" ? COUNTRY_EMBLEMS : family === "region" ? REGION_EMBLEMS : STYLE_EMBLEMS;
  const found = registry[value];
  if (found) return found();
  return <MonogramEmblem letter={(value[0] ?? "?").toUpperCase()} />;
}

// ---------------------------------------------------------------------------
// The badge
// ---------------------------------------------------------------------------

function Laurels(): ReactElement {
  const leaves: ReactElement[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const a = ((96 + i * 13) * Math.PI) / 180;
      const x = Number((36 + side * 34.5 * Math.sin(a)).toFixed(1));
      const y = Number((38 + 34.5 * Math.cos(a) - 4).toFixed(1));
      const rot = side * (18 + i * 13);
      leaves.push(<ellipse key={`${side}-${i}`} cx={x} cy={y} rx={2.1} ry={4.6} fill={GOLD} transform={`rotate(${rot} ${x} ${y})`} />);
    }
  }
  return <g opacity={0.92}>{leaves}</g>;
}

export interface PassportBadgeIconProps {
  family: PassportFamily;
  value: string;
  /** Held tier 1-5; anything outside clamps into range. */
  tier: number;
  /** Rendered size in px (width; height keeps the 72:84 ratio). */
  size?: number;
  /**
   * Distinct bottles met. Rendered as a corner chip only when the size has
   * room (≥48px) — smaller contexts (pour cards, note rows) show the clean
   * crest and leave the numbers to their tooltip.
   */
  count?: number | null;
  /** When standalone, labels the svg; inside a labeled control leave unset. */
  label?: string;
  className?: string;
}

export function PassportBadgeIcon({ family, value, tier, size = 48, count, label, className }: PassportBadgeIconProps): ReactElement {
  const clamped = Math.min(5, Math.max(1, Math.round(tier)));
  const metal = TIER_METALS[clamped];
  const spec = tierSpec(clamped);
  const showBanner = size >= 36;
  const showCount = count != null && size >= 48;
  // Deterministic ids: duplicates on a page are harmless because identical
  // badges declare identical defs.
  const idBase = `pb-${family}-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${clamped}`;
  const outer =
    family === "country" ? (
      <path d={SHIELD_OUTER} />
    ) : family === "region" ? (
      <circle cx={36} cy={38} r={31} />
    ) : (
      <polygon points={HEX_OUTER} />
    );
  const inner =
    family === "country" ? (
      <path d={SHIELD_INNER} />
    ) : family === "region" ? (
      <circle cx={36} cy={38} r={25} />
    ) : (
      <polygon points={HEX_INNER} />
    );
  const detail =
    family === "country" ? (
      <path d={SHIELD_INNER} fill="none" strokeOpacity={0.55} strokeDasharray="1 3" />
    ) : family === "region" ? (
      <circle cx={36} cy={38} r={28} fill="none" strokeOpacity={0.7} strokeDasharray="1.2 3.4" />
    ) : (
      <polygon points={HEX_DETAIL} fill="none" strokeOpacity={0.55} strokeDasharray="1 3" />
    );

  return (
    <svg
      width={size}
      height={(size * 84) / 72}
      viewBox="0 0 72 84"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={className}
      style={clamped === 5 ? { filter: "drop-shadow(0 0 10px rgba(232,161,60,.35))" } : undefined}
    >
      <defs>
        <linearGradient id={`${idBase}-ring`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={metal.ring0} />
          <stop offset="1" stopColor={metal.ring1} />
        </linearGradient>
        <clipPath id={`${idBase}-clip`}>{inner}</clipPath>
      </defs>
      {clamped === 5 && <Laurels />}
      <g fill={`url(#${idBase}-ring)`} stroke={metal.edge} strokeWidth={1}>
        {outer}
      </g>
      <g stroke={metal.edge} strokeWidth={1}>
        {detail}
      </g>
      <g fill={FIELD_BG}>{inner}</g>
      <g clipPath={`url(#${idBase}-clip)`}>
        <Emblem family={family} value={value} />
        <rect x={6} y={4} width={60} height={14} fill="#fff" opacity={0.05} />
      </g>
      {showBanner && (
        <>
          <path d="M23.5 66 H48.5 L45 78.5 H27 Z" fill={`url(#${idBase}-ring)`} stroke={metal.ring1} strokeWidth={0.8} />
          <text
            x={36}
            y={75.4}
            textAnchor="middle"
            fontFamily="var(--font-fraunces), Georgia, serif"
            fontWeight={700}
            fontSize={9.5}
            fill={metal.text}
          >
            {spec?.numeral}
          </text>
        </>
      )}
      {showCount && (
        <>
          <circle cx={59.5} cy={61} r={9} fill={INK} stroke={GOLD} strokeWidth={1.1} />
          <text
            x={59.5}
            y={64}
            textAnchor="middle"
            fontFamily="var(--font-geist-sans), system-ui, sans-serif"
            fontWeight={600}
            fontSize={8}
            fill={CREAM}
          >
            {count}
          </text>
        </>
      )}
    </svg>
  );
}
