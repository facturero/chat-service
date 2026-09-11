import { describe, it, expect } from 'vitest';
import { MessageStatus, isValidUuid, generateUuid } from '../domain/value-objects.js';

describe('MessageStatus', () => {
  it('permite transiciones válidas', () => {
    expect(MessageStatus.canTransition('sent', 'delivered')).toBe(true);
    expect(MessageStatus.canTransition('delivered', 'read')).toBe(true);
  });

  it('no permite saltar estados', () => {
    expect(MessageStatus.canTransition('sent', 'read')).toBe(false);
  });

  it('valida valores permitidos', () => {
    expect(MessageStatus.isValid('read')).toBe(true);
    expect(MessageStatus.isValid('nope')).toBe(false);
  });
});

describe('UUID', () => {
  it('generateUuid produce un uuid v4 válido', () => {
    expect(isValidUuid(generateUuid())).toBe(true);
  });
});