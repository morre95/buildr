declare module "react" {
  const React: {
    createElement: (...args: unknown[]) => any;
  };

  export namespace React {
    type ReactElement = any;
  }

  export default React;
}
