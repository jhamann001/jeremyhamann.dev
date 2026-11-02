type WaiverDateInputs = {
  waiverStart: string | null;
  waiverDurationMonths: number | null;
  indefiniteDuration: boolean;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

// Requests cover whole calendar months. The restart month is the first month
// after the waiver, not the final waived month. Keep this free of time zones.
export function feeRequestWaiverDates(input: WaiverDateInputs): {
  waiverStart: string;
  billingRestart: string;
} {
  const match = /^(\d{4})-(\d{2})$/.exec(input.waiverStart ?? "");
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const validStart = !!match && year >= 1900 && year <= 9999 && month >= 1 && month <= 12;
  const waiverStart = validStart ? `${MONTHS[month - 1]} ${year}` : "Unavailable";
  if (input.indefiniteDuration) return { waiverStart, billingRestart: "No scheduled restart" };

  const duration = input.waiverDurationMonths;
  if (!validStart || duration === null || !Number.isInteger(duration) || duration < 1 || duration > 120) {
    return { waiverStart, billingRestart: "Unavailable" };
  }

  const restartIndex = year * 12 + month - 1 + duration;
  const restartYear = Math.floor(restartIndex / 12);
  return {
    waiverStart,
    billingRestart: restartYear > 9999 ? "Unavailable" : `${MONTHS[restartIndex % 12]} ${restartYear}`,
  };
}
