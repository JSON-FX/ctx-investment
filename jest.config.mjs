/** @type {import('jest').Config} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/lib"],
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/$1" },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { target: "ES2022", module: "CommonJS" } }],
  },
};
