// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Joakim Langkilde
//
// Flat ESLint config. Core rules only (no plugins), so CI can run it with a bare
// `npx eslint` — matching the project's no-build ethos. Catches bug-class issues;
// formatting is Prettier's job (see .prettierrc.json).
'use strict';

// Browser globals the classic scripts share (they run in one global scope).
const browser = {
    window: 'readonly',
    self: 'readonly',
    document: 'readonly',
    navigator: 'readonly',
    console: 'readonly',
    location: 'readonly',
    fetch: 'readonly',
    localStorage: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    requestAnimationFrame: 'readonly',
    cancelAnimationFrame: 'readonly',
    performance: 'readonly',
    getComputedStyle: 'readonly',
    matchMedia: 'readonly',
    Blob: 'readonly',
    File: 'readonly',
    FileReader: 'readonly',
    URL: 'readonly',
    Image: 'readonly',
    Audio: 'readonly',
    Event: 'readonly',
    CustomEvent: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    structuredClone: 'readonly',
    btoa: 'readonly',
    atob: 'readonly',
    alert: 'readonly',
    confirm: 'readonly',
    prompt: 'readonly',
    requestIdleCallback: 'readonly',
};
const node = {
    require: 'readonly',
    module: 'writable',
    process: 'readonly',
    __dirname: 'readonly',
};

const bugRules = {
    'no-undef': 'error',
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-redeclare': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-unreachable': 'error',
    'no-cond-assign': ['error', 'except-parens'],
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-self-assign': 'error',
    'no-fallthrough': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error',
};

module.exports = [
    { ignores: ['firmware/**'] },
    {
        // app.js consumes WebDFU (dfu.js) and the core.js helpers as shared globals.
        files: ['app.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...browser,
                WebDFU: 'readonly',
                NOTE_NAMES: 'readonly',
                clamp01: 'readonly',
                rotFor: 'readonly',
                semverGt: 'readonly',
                cablePath: 'readonly',
                noteName: 'readonly',
                describeMidi: 'readonly',
            },
        },
        rules: bugRules,
    },
    {
        // Definition sites: dfu.js defines WebDFU; core.js defines the helpers + a
        // CommonJS export guard (so `module` may appear).
        files: ['dfu.js', 'core.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...browser, module: 'writable' },
        },
        rules: bugRules,
    },
    {
        // Node contexts: the test suite and this config file.
        files: ['test/**/*.js', 'eslint.config.js'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: node },
        rules: bugRules,
    },
];
