export interface ClientRequestPayload {
  clientRequestId: string;
  name: string;
  email: string;
  company?: string | null;
  phone?: string | null;
  phoneCountry?: string | null;
  services?: string[];
  message?: string | null;
}

export function parseClientRequestPayload(
  raw: unknown,
): ClientRequestPayload | null {
  if (!raw || typeof raw !== 'object') return null;

  const p = raw as Record<string, unknown>;

  if (typeof p.clientRequestId !== 'string') return null;
  if (typeof p.name !== 'string') return null;
  if (typeof p.email !== 'string') return null;

  return p as unknown as ClientRequestPayload;
}
