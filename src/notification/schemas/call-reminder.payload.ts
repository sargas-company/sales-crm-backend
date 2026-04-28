export interface CallReminderPayload {
  callId: string;
  callTitle: string;
  reminderType: '60min' | '10min';
  clientName: string;
  clientType: 'lead' | 'client_request';
  clientDateTime: string;
  clientTimezone: string;
  kyivDateTime: string;
  durationMin: number;
  meetingUrl?: string | null;
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
  if (p.reminderType !== '60min' && p.reminderType !== '10min') return null;
  if (typeof p.clientName !== 'string') return null;
  if (p.clientType !== 'lead' && p.clientType !== 'client_request') return null;
  if (typeof p.clientDateTime !== 'string') return null;
  if (typeof p.clientTimezone !== 'string') return null;
  if (typeof p.kyivDateTime !== 'string') return null;
  if (typeof p.durationMin !== 'number') return null;
  if (!isNullableString(p.meetingUrl)) return null;

  return p as unknown as CallReminderPayload;
}
