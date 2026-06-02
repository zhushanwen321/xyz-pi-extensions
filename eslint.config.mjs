import tasteConfig from './packages/taste-lint/base.mjs';

export default [
  ...tasteConfig,
  {
    ignores: [
      // 独立 JS 脚本（不用 TS 规则检查）
      '.pi/workflows/**',
      'skills/browser-automation/scripts/**',
    ],
  },
];
