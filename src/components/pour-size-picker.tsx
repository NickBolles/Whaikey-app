"use client";

const COMMON_POUR_SIZES = [15, 25, 30, 45, 60] as const;
const NORMAL_POUR_ML = 45;
const SNAP_DISTANCE_ML = 2;
const MIN_POUR_ML = 15;
const MAX_POUR_ML = 60;

const POUR_MARKERS = COMMON_POUR_SIZES.map((size) => ({
  size,
  position: ((size - MIN_POUR_ML) / (MAX_POUR_ML - MIN_POUR_ML)) * 100,
}));

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
    <div className="flex flex-col gap-2.5" aria-label="Pour size">
      <div className="flex items-baseline justify-between gap-3">
        <span className="section-label">Pour size</span>
        <output htmlFor="pour-size" className="font-display text-lg text-accent" aria-live="polite">
          {valueLabel}
        </output>
      </div>
      <div>
        <div className="relative h-6">
          <input
            id="pour-size"
            type="range"
            min={MIN_POUR_ML}
            max={MAX_POUR_ML}
            step="1"
            value={value}
            onChange={(event) => onChange(snapPourSize(Number(event.target.value)))}
            aria-label="Pour size"
            aria-valuetext={valueLabel}
            list="common-pour-sizes"
            className="absolute inset-0 z-10 h-6 w-full cursor-pointer appearance-none bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-accent [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-border-subtle [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-border-subtle [&::-webkit-slider-thumb]:-mt-2 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-accent"
          />
          <div aria-hidden className="pointer-events-none absolute inset-x-2.5 top-1/2 z-0 -translate-y-1/2">
            {POUR_MARKERS.map(({ size, position }) => (
              <span
                key={size}
                data-testid="pour-size-tick"
                className="absolute h-2.5 w-px -translate-x-1/2 bg-muted"
                style={{ left: `${position}%` }}
              />
            ))}
          </div>
        </div>
        <datalist id="common-pour-sizes">
          {COMMON_POUR_SIZES.map((size) => <option key={size} value={size} />)}
        </datalist>
        <div className="relative mx-2.5 mt-1 h-8 text-[11px] text-muted">
          {POUR_MARKERS.map(({ size, position }, index) => (
            <span
              key={size}
              className={`absolute top-0 whitespace-nowrap leading-tight ${
                index === 0 ? "translate-x-0 text-left" : index === POUR_MARKERS.length - 1 ? "-translate-x-full text-right" : "-translate-x-1/2 text-center"
              } ${size === NORMAL_POUR_ML ? "text-foreground" : ""}`}
              style={{ left: `${position}%` }}
            >
              {size} ml{size === NORMAL_POUR_ML ? " normal" : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
