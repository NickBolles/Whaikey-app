"use client";

const COMMON_POUR_SIZES = [15, 25, 30, 45, 60] as const;
const NORMAL_POUR_ML = 45;
const SNAP_DISTANCE_ML = 2;

/** Keep the slider flexible while making the common pour sizes easy to land on. */
export function snapPourSize(value: number): number {
  const nearest = COMMON_POUR_SIZES.find((size) => Math.abs(size - value) <= SNAP_DISTANCE_ML);
  return nearest ?? value;
}

export function PourSizePicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const valueLabel = value === NORMAL_POUR_ML ? `${value} ml — normal pour` : `${value} ml`;

  return (
    <div className="flex flex-col gap-3" aria-label="Pour size">
      <div className="flex items-baseline justify-between gap-3">
        <span className="section-label">Pour size</span>
        <output htmlFor="pour-size" className="font-display text-lg text-accent" aria-live="polite">
          {valueLabel}
        </output>
      </div>
      <input
        id="pour-size"
        type="range"
        min="5"
        max="90"
        step="1"
        value={value}
        onChange={(event) => onChange(snapPourSize(Number(event.target.value)))}
        aria-label="Pour size"
        aria-valuetext={valueLabel}
        className="w-full accent-accent"
      />
      <div className="grid grid-cols-5 gap-1" aria-label="Common pour sizes">
        {COMMON_POUR_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            aria-pressed={value === size}
            onClick={() => onChange(size)}
            className={`chip min-h-11 px-1 text-xs ${
              value === size ? "chip-active font-medium" : "hover:bg-surface-raised"
            }`}
          >
            {size} ml{size === NORMAL_POUR_ML ? " normal" : ""}
          </button>
        ))}
      </div>
    </div>
  );
}
