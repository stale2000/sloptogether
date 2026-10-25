export function bitsOutcome(state) {
  switch (state) {
    case "receipt_seen": return { pending: true, error: false, text: "Receipt received. Verification in progress; do not use Bits again yet." };
    case "receipt_unverified": return { pending: true, error: false, text: "Receipt not verified. No render started; do not use Bits again yet." };
    case "reserved": return { pending: false, error: false, text: "One Turbo render attempt is reserved for this scene." };
    case "paid_unfulfilled": return { pending: false, error: true, text: "Bits action could not be completed. Contact the channel owner." };
    case "verified_unallocated": return { pending: false, error: true, text: "Bits action could not be matched to this scene. Contact the channel owner." };
    case "development_ignored": return { pending: false, error: true, text: "Test transaction. No render was started." };
    case "consumed_succeeded": return { pending: false, error: false, text: "The Turbo render attempt completed." };
    case "consumed_failed":
    case "consumed_rejected":
    case "consumed_uncertain": return { pending: false, error: true, text: "This Bits exchange's single render attempt is spent. A new attempt needs a new exchange." };
    case "expired": return { pending: false, error: false, text: "The Bits action expired without a receipt. No render was started." };
    case "cancelled": return { pending: false, error: true, text: "The Bits action was cancelled. No render was started." };
    default: return { pending: true, error: false, text: "Verification in progress." };
  }
}

export function isLateReceiptGracePending(state, transactionReceived, expiresAt, now = Date.now()) {
  const expiry = Date.parse(expiresAt || "");
  return state === "expired" && !transactionReceived && Number.isFinite(expiry) && now < expiry + 10 * 60_000;
}
