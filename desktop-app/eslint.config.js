import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src-tauri'] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      react.configs.flat.recommended,
      react.configs.flat['jsx-runtime'],
    ],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],

      // 未使用变量：设为 warn（项目中大量存在，不影响运行）
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // any 类型：warn
      '@typescript-eslint/no-explicit-any': 'warn',

      // 空块语句：warn（项目中大量使用空 catch 块忽略错误）
      'no-empty': ['warn', { allowEmptyCatch: true }],

      // 常量条件：warn（项目中 while(true) 等算法循环是正常写法）
      'no-constant-condition': 'warn',

      // no-useless-escape：off（字符类中 \[ 的检测会导致误报）
      'no-useless-escape': 'off',

      // @ts-nocheck / @ts-ignore 注释：off（大型遗留文件暂时不处理类型错误）
      '@typescript-eslint/ban-ts-comment': 'off',

      // 关闭过于严格的 immutability 规则（React 中 effect 引用后面声明的 hook 是正常写法）
      'react-hooks/immutability': 'off',

      // 以下 react-hooks v5+ 新增规则对已有项目过于严格，设为 off
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  // 排除 vite.config.ts 和 .bak 文件
  {
    ignores: ['vite.config.ts', '**/*.bak_*', '**/*.bak'],
  }
);
