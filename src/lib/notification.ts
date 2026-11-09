// TASK-917 (REQ-120 R0.4) - the notification type vocabulary (the seven types of the DB CHECK). Pure. NO MONEY in any notification text.
// (The Low-Stock rules - thresholds, which products are low, the Monday job - are Bob's TASK-919 and live with his code.)
export const NOTIFY_TYPES = ["Bonus", "Commission", "Transportation", "OT", "Other", "Low Stock", "Extra Hour"] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];
export const isNotifyType = (v: string): v is NotifyType => (NOTIFY_TYPES as readonly string[]).includes(v);
