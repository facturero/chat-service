import { MembershipsResolver } from '../../application/ports.js';

interface AccessContextResponse {
    orgId: string | null;
    countryCode: string | null;
    permissions: string[];
    pv: number;
}

export class AuthServiceMembershipsResolver implements MembershipsResolver {
    constructor(
        private readonly baseUrl: string,
        private readonly internalSecret: string,
    ){}

    async isMember(userId: string, organizationId: string): Promise<boolean> {
        const url = `${this.baseUrl}/internal/users/${encodeURIComponent(userId)}/access-context?orgId=${encodeURIComponent(organizationId)}`;
        const response = await fetch(url, {
            headers: {
                'X-Internal-Secret': this.internalSecret,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`Error al validar membresía con auth-service: ${response.status} ${response.statusText}`);
        }

        const context = (await response.json()) as AccessContextResponse;
        return context.orgId === organizationId;
    }
}