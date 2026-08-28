import globals from "globals";
import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";

export default [
    {
        ignores: [
            "node_modules/**",
            "artifacts/**",
            "cache/**",
            "typechain-types/**",
            "coverage/**",
            "dist/**",
        ],
    },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: parser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: "module",
            },
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
        },
        plugins: {
            "@typescript-eslint": tseslint,
        },
        rules: {
            // Disable inline eslint-disable warnings
            "no-console": "off",
        },
    },
    {
        files: ["**/*.js", "**/*.mjs"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
        },
        rules: {
            "no-console": "off",
        },
    },
];
