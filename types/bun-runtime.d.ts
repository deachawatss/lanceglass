declare const Bun: any;

declare namespace Bun {
  type Subprocess<
    _Stdin = unknown,
    _Stdout = unknown,
    _Stderr = unknown,
  > = any;
}

interface ImportMeta {
  readonly dir: string;
  readonly main: boolean;
}
