import { Repositories } from '../domain/repositories.js';

export interface UnitOfWork {
    execute<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export interface MembershipsResolver {
  isMember(userId: string, organizationId: string): Promise<boolean>;
}