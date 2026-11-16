import type { TeamDirectory } from '../../application/ports.js';

/**
 * Directorio del equipo en auth-service (`GET /internal/organizations/:id/contacts`, con `X-Internal-Secret`): los usuarios ACTIVOS de la
 * organización. Lo usa #general al crearse y la validación de «a quién se puede sumar». La misma ruta que usa notification-service.
 */
export class AuthTeamDirectory implements TeamDirectory {
  constructor(private readonly baseUrl: string, private readonly internalSecret: string) {}

  async activeUserIds(organizationId: string): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/internal/organizations/${encodeURIComponent(organizationId)}/contacts`, {
      headers: { 'X-Internal-Secret': this.internalSecret },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`auth-service respondió ${res.status} al pedir el equipo de la organización`);
    const body = (await res.json()) as { users?: Array<{ id?: unknown }> };
    return (body.users ?? []).map((u) => u.id).filter((id): id is string => typeof id === 'string').map((id) => id.toLowerCase());
  }
}
