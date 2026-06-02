/**
 * CodeTaste ESLint 基础配置 — TypeScript / Node.js 项目
 *
 * 从 llm-simple-router/taste-lint/base.mjs 适配而来，
 * 移除了 Vue/Router 专用规则（no-hardcoded-colors、no-magic-spacing 等）。
 *
 * 使用：在项目 eslint.config.mjs 中导入
 *   import tasteConfig from './taste-lint/base.mjs';
 *   export default tasteConfig;
 *
 * 依赖：typescript-eslint
 */
import tseslint from 'typescript-eslint';
import preferAllsettled from './rules/prefer-allsettled.mjs';
import noSilentCatch from './rules/no-silent-catch.mjs';
import noUnboundedWhileTrue from './rules/no-unbounded-while-true.mjs';
import noInlineImportType from './rules/no-inline-import-type.mjs';
import noEslintDisable from './rules/no-eslint-disable.mjs';

export const tastePlugin = {
  meta: { name: 'eslint-plugin-taste' },
  rules: {
    'prefer-allsettled': preferAllsettled,
    'no-silent-catch': noSilentCatch,
    'no-unbounded-while-true': noUnboundedWhileTrue,
    'no-inline-import-type': noInlineImportType,
    'no-eslint-disable': noEslintDisable,
  },
};

/** 品味规则配置 */
export const tasteRules = {
  // 类型即契约
  // Pi Extension API 回调参数通过 types stub 解析为 any，不可避免
  // 业务逻辑中的 any 滥用通过 code review 控制
  '@typescript-eslint/no-explicit-any': 'warn',

  // 允许 _ 前缀的未使用变量和参数（惯用模式）
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

  // 结构先于一切
  'max-lines': ['warn', { max: 1000, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],

  // 语义化命名
  'no-magic-numbers': ['warn', {
    ignore: [0, 1, -1],
    ignoreArrayIndexes: true,
  }],

  // 反馈不断裂
  'no-empty': 'error',

  // 安全无例外
  'no-eval': 'error',
  'no-implied-eval': 'error',

  // 品味自定义规则
  'taste/prefer-allsettled': 'warn',
  'taste/no-silent-catch': 'warn',
  'taste/no-unbounded-while-true': 'warn',
  'taste/no-inline-import-type': 'warn',
  // taste/no-eslint-disable 通过 githook pre-commit 在变更文件中强制执行，不在 ESLint 配置中启用
};

export default [
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { taste: tastePlugin },
    rules: tasteRules,
  },
  {
    ignores: ['**/node_modules/**', '.superpowers/**', '.xyz-harness/**', '**/*.d.ts'],
  },
];
