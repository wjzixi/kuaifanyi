import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: ["node_modules/**", "main.js", "esbuild.config.cjs"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
