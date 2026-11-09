// TASK-920 (REQ-120 R0.2 / R0.4, ขวัญ S17) - the SALARY notification events: one feed item per pay line WRITTEN of a notifiable kind, to everyone `recipientsForType` returns (TASK-917's seam).
//
//   Bonus · Transportation · Extra Hour · OT · Other  -> wired at their write points (bonus-lines / transport / the pay run / addOt / addLine + addEntry).
//   Commission -> NO writer exists in BB yet: `notifyCommission` is the one helper the future commission writer calls.
//   Merit and FL pay are NOT notification types (917's seven), and nothing here is called for a delete, an orphan, or a `changed` (report-only) line.
//
// 🚫 NO MONEY, EVER: an admin sees the same item (R0.2). The text is `<Type> · <coach> · <dd/mm/yy>` + ONE detail with no amount; the only free text (an `Other` reason) is dropped to
// «Other item» when it holds ANY digit or a currency word/symbol. A pay line is already committed when this runs; a notification failure is caught, logged and COUNTED, never thrown.
import { bangkokDate } from "../lib/stock-read";
import type { NotifyType } from "../lib/notification";
import { notificationService } from "./notification.service";

export interface NotifyEvent { type: NotifyType; text: string; occurredOn: string; key: string }
/** Writes one event to everyone assigned its type. Resolves true when it succeeded, false when it failed (never throws). */
export type NotifyFn = (e: NotifyEvent) => Promise<boolean>;

/** `YYYY-MM-DD` -> `dd/mm/yy` (the final UI's date). */
export const dmy = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(2, 4)}`;

/** Hours for a text: 120 -> "2 Hr", 90 -> "1.5 Hr", 45 -> "0.75 Hr". */
export const hoursText = (minutes: number): string => `${Math.round((minutes / 60) * 100) / 100} Hr`;

/** True when a free-text reason could carry a money figure: any digit, a currency symbol, or a currency word. Deliberately blunt: a false positive only costs the detail. */
export const looksLikeMoney = (s: string): boolean => /\d|[฿$€£]|บาท|สตางค์|baht|satang|thb/i.test(s);

/** `<Type> · <coach> · <dd/mm/yy>` + ` · <detail>`. The coach is the word "coach" when unknown. NO amount is ever passed in. */
export function payLineText(type: NotifyType, coach: string | null | undefined, day: string, detail?: string | null): string {
  const head = `${type} · ${coach?.trim() || "coach"} · ${dmy(day)}`;
  return detail ? `${head} · ${detail}` : head;
}

/** REQ-5010's words: Bonus 50 = "1st Trial", Bonus 100 = "Renew". `sourceRef` is `b50:...` / `b100:...`. */
export const bonusDetail = (sourceRef: string): string => (sourceRef.startsWith("b100") ? "Renew" : "1st Trial");
/** `<school> · Round trip | One way`. */
export const transportDetail = (school: string, roundTrip: boolean): string => `${school.trim() || "school"} · ${roundTrip ? "Round trip" : "One way"}`;
/** The reason AS TYPED, or "Other item" when it is empty or could hold money. */
export const otherDetail = (reason: string | null | undefined): string => {
  const r = (reason ?? "").replace(/\s+/g, " ").trim();
  return !r || looksLikeMoney(r) ? "Other item" : r.length > 200 ? `${r.slice(0, 200)}…` : r;
};

/** The idempotency keys: an auto line = `pay:<slipId>:<kind>:<sourceRef>`; a manual line = `pay-line:<lineId>`. A re-run or a double click cannot notify twice. */
export const autoLineKey = (slipId: string, kind: string, sourceRef: string): string => `pay:${slipId}:${kind}:${sourceRef}`;
export const manualLineKey = (lineId: string): string => `pay-line:${lineId}`;

/** The real notifier: writes through the 917 seam; a failure is logged (no text, no recipient) and reported as `false`. */
export const realNotify: NotifyFn = async (e) => {
  try {
    await notificationService.notifyAssigned({ type: e.type, text: e.text, occurredOn: e.occurredOn, key: e.key });
    return true;
  } catch (err) {
    console.error(`[notify] ${e.type} event failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};

/** Fire one event through `notify` (absent = notifications off). Never throws; returns how many failed (0 or 1). */
export async function fire(notify: NotifyFn | undefined, e: NotifyEvent): Promise<{ failed: number }> {
  if (!notify) return { failed: 0 };
  try {
    return { failed: (await notify(e)) ? 0 : 1 };
  } catch {
    return { failed: 1 };
  }
}

/** THE HELPER for the future Commission writer (none exists in BB today): call it right after the commission line is written, with its id. */
export function notifyCommission(notify: NotifyFn | undefined, l: { lineId: string; coach: string | null; day?: string; detail?: string | null }): Promise<{ failed: number }> {
  const day = l.day ?? bangkokDate(new Date());
  const detail = l.detail && !looksLikeMoney(l.detail) ? l.detail.trim() : null; // a commission detail is free text: dropped when it could hold money
  return fire(notify, { type: "Commission", text: payLineText("Commission", l.coach, day, detail), occurredOn: day, key: manualLineKey(l.lineId) });
}
