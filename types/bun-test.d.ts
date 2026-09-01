declare module "bun:test" {
  type TestBody = () => unknown | Promise<unknown>;
  export const afterEach: (body: TestBody) => void;
  export const describe: (name: string, body: TestBody) => void;
  export const expect: any;
  export const test: (name: string, body: TestBody) => void;
}
