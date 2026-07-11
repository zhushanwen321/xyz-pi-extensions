import tasteConfig from './shared/taste-lint/base.mjs';

export default [
  ...tasteConfig,
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/tests/**/*.ts'],
    rules: {
      // 测试 fixture 值（时间偏移、大小阈值等）在上下文中自解释，无需命名常量
      'no-magic-numbers': 'off',
      // 测试 mock 常用 `as any` 绕过类型构造 fixture；生产代码仍强制 error。
      // 测试的类型正确性由契约测试（sdk-contract.test.ts 等）把关。
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: [
      // 独立 JS 脚本（不用 TS 规则检查）
      '.pi/workflows/**',
      'extensions/*/workflows/**',
      'extensions/*/.pi/workflows/**',
      // 示例文件（给用户的 CommonJS 脚本，非项目源码）
      'extensions/*/examples/**',
      'skills/browser-automation/scripts/**',
    ],
  },
];
