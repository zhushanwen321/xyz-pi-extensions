import tasteConfig from './shared/taste-lint/base.mjs';

export default [
  ...tasteConfig,
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/tests/**/*.ts'],
    rules: {
      // 测试 fixture 值（时间偏移、大小阈值等）在上下文中自解释，无需命名常量
      'no-magic-numbers': 'off',
    },
  },
  {
    ignores: [
      // 独立 JS 脚本（不用 TS 规则检查）
      '.pi/workflows/**',
      'skills/browser-automation/scripts/**',
    ],
  },
];
