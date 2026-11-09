// TASK-893 (SPEC-099 §10 (2)) — the back office asks the scheduling side to cancel the refunded course / voucher: `POST {SCHEDULER_API_URL}/internal/refund-cancel`
// (smart-scheduler-back TASK-892), header `x-internal-secret`. The SAME shape as `callRemindNow` in `slip-confirm.service.ts`:
// either env key unset ⇒ `"NOT_CONFIGURED"` and NO request; a 200 with the expected body ⇒ the result; ANY other status, a timeout
// (5 s), a network error or a body that is not the contract ⇒ `"FAILED"`. It never throws, so the caller decides what each outcome means.
//
// ⚠️ The env keys are the ones BB already has: `SCHEDULER_API_URL` and `SCHEDULER_INTERNAL_SECRET` (`.env.example`, TASK-887). SPEC-099 §10 calls the secret
// `INTERNAL_JOB_SECRET`: that is the NAME ON THE SB BOX (the value must match); on BB's side the key is `SCHEDULER_INTERNAL_SECRET`.
export type CancelAnswer = { cancelledSessions: number; alreadyCancelled: boolean };
export type CancelResult = "NOT_CONFIGURED" | "FAILED" | CancelAnswer;

export async function callRefundCancel(
  input: { refType: "COURSE" | "VOUCHER"; refId: string; actor: string | null },
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<CancelResult> {
  const base = env.SCHEDULER_API_URL?.trim().replace(/\/+$/, "");
  const secret = env.SCHEDULER_INTERNAL_SECRET?.trim();
  if (!base || !secret) return "NOT_CONFIGURED";
  try {
    const res = await fetchFn(`${base}/internal/refund-cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ refType: input.refType, refId: input.refId, ...(input.actor ? { actor: input.actor } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200) return "FAILED";
    const body = (await res.json()) as Partial<CancelAnswer> | null;
    if (!body || typeof body !== "object" || !Number.isInteger(body.cancelledSessions) || (body.cancelledSessions as number) < 0 || typeof body.alreadyCancelled !== "boolean") return "FAILED";
    return { cancelledSessions: body.cancelledSessions as number, alreadyCancelled: body.alreadyCancelled };
  } catch {
    return "FAILED";
  }
}
