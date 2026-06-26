import { DEVELOPMENT_JWT_SECRET, envValidationSchema } from './env.validation';

describe('envValidationSchema JWT_SECRET', () => {
  it.each([{}, { JWT_SECRET: DEVELOPMENT_JWT_SECRET }, { JWT_SECRET: 'short-production-secret' }])(
    'rejects unsafe production configuration: %p',
    (input) => {
      const result = envValidationSchema.validate({
        NODE_ENV: 'production',
        ...input,
      });

      expect(result.error).toBeDefined();
    },
  );

  it('accepts an explicit strong production secret', () => {
    const result = envValidationSchema.validate({
      NODE_ENV: 'production',
      JWT_SECRET: 'a-strong-production-secret-with-32-plus-characters',
    });

    expect(result.error).toBeUndefined();
  });

  it.each(['development', 'test'] as const)('keeps the documented fallback in %s', (nodeEnv) => {
    const result = envValidationSchema.validate({ NODE_ENV: nodeEnv });

    expect(result.error).toBeUndefined();
    expect(result.value.JWT_SECRET).toBe(DEVELOPMENT_JWT_SECRET);
  });
});
