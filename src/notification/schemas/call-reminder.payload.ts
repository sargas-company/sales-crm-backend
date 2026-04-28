export interface CallReminderPayload {
  callId: string;
  callTitle: string;
  scheduledAt: string;
  reminderType: '60min' | '10min';
  meetingUrl?: string | null;
  kyivDateTime: string;
}

function isNullableString(v: unknown): v is string | null | undefined {
  return v === null || v === undefined || typeof v === 'string';
}

export function parseCallReminderPayload(
  raw: unknown,
): CallReminderPayload | null {
  if (!raw || typeof raw !== 'object') return null;

  const p = raw as Record<string, unknown>;

  if (typeof p.callId !== 'string') return null;
  if (typeof p.callTitle !== 'string') return null;
  if (typeof p.scheduledAt !== 'string') return null;
  if (p.reminderType !== '60min' && p.reminderType !== '10min') return null;
  if (!isNullableString(p.meetingUrl)) return null;
  if (typeof p.kyivDateTime !== 'string') return null;

  return p as unknown as CallReminderPayload;
}
