// ESLint flat config: TypeScript type-aware rules for src/, tests/ and bench/.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'bench/results/**', 'apps-script/**', 'bench/k6-webhook.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `async` without `await` is used on purpose to implement Promise-returning interfaces.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Test doubles and HTTP responses (`inject().json()`) are loosely typed on purpose.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
