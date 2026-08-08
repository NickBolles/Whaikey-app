/**
 * Semantic haptics (docs/NATIVE_APP.md §3.1).
 *
 * Call sites name the *moment* ("a bottle was shelved"), not the waveform, so
 * the feel of the app can be tuned in one place. On the web this falls back to
 * `navigator.vibrate` — which Android honours and iOS Safari ignores entirely.
 * Getting real taptic feedback on iPhone is one of the concrete wins of the
 * native shell over the web app.
 */
import { loadPlugin } from "./platform";

export type HapticMoment =
  /** A discrete choice landed: a flavor wedge, a star, a chip. */
  | "tap"
  /** The scanner locked onto a barcode. */
  | "lock"
  /** Something was saved: a bottle shelved, a pour logged. */
  | "success"
  /** Something needs attention: a duplicate scan, a failed save. */
  | "warning";

/** Web fallback durations in ms; a pattern array reads as a double-buzz. */
const WEB_PATTERN: Record<HapticMoment, number | number[]> = {
  tap: 12,
  lock: 30,
  success: 60,
  warning: [40, 60, 40],
};

/**
 * Fire a haptic for a product moment. Always safe to call: never throws, never
 * awaits anything the caller needs, and silently does nothing on hardware or
 * browsers without vibration.
 */
export function haptic(moment: HapticMoment): void {
  void run(moment);
}

async function run(moment: HapticMoment): Promise<void> {
  const plugin = await loadPlugin(() => import("@capacitor/haptics"));
  if (!plugin) {
    // navigator.vibrate is absent on iOS Safari and desktop; optional-call it.
    try {
      navigator.vibrate?.(WEB_PATTERN[moment]);
    } catch {
      // Some browsers throw when vibration is blocked by user settings.
    }
    return;
  }

  const { Haptics, ImpactStyle, NotificationType } = plugin;
  try {
    switch (moment) {
      case "tap":
        await Haptics.impact({ style: ImpactStyle.Light });
        break;
      case "lock":
        await Haptics.impact({ style: ImpactStyle.Medium });
        break;
      case "success":
        await Haptics.notification({ type: NotificationType.Success });
        break;
      case "warning":
        await Haptics.notification({ type: NotificationType.Warning });
        break;
    }
  } catch {
    // Haptics are disabled system-wide or unsupported on this device.
  }
}
