import { describe, it, expect } from 'vitest';
import { ValidationError, EmbeddingError, DbError } from '../../src/errors.js';

describe('ValidationError', () => {
  it('should set name to ValidationError', () => {
    const err = new ValidationError('bad input');
    expect(err.name).toBe('ValidationError');
  });

  it('should set message', () => {
    const err = new ValidationError('field is required');
    expect(err.message).toBe('field is required');
  });

  it('should be instanceof Error', () => {
    const err = new ValidationError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('should chain cause via ErrorOptions', () => {
    const original = new Error('root cause');
    const err = new ValidationError('wrapper', { cause: original });
    expect(err.cause).toBe(original);
  });
});

describe('EmbeddingError', () => {
  it('should set name to EmbeddingError', () => {
    const err = new EmbeddingError('api failed');
    expect(err.name).toBe('EmbeddingError');
  });

  it('should set message', () => {
    const err = new EmbeddingError('timeout');
    expect(err.message).toBe('timeout');
  });

  it('should be instanceof Error', () => {
    const err = new EmbeddingError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('should chain cause via ErrorOptions', () => {
    const original = new TypeError('bad type');
    const err = new EmbeddingError('embedding failed', { cause: original });
    expect(err.cause).toBe(original);
  });
});

describe('DbError', () => {
  it('should set name to DbError', () => {
    const err = new DbError('insert failed');
    expect(err.name).toBe('DbError');
  });

  it('should set message', () => {
    const err = new DbError('connection refused');
    expect(err.message).toBe('connection refused');
  });

  it('should be instanceof Error', () => {
    const err = new DbError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('should chain cause via ErrorOptions', () => {
    const original = new Error('pg error');
    const err = new DbError('query failed', { cause: original });
    expect(err.cause).toBe(original);
  });
});
