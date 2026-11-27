/**
 * Compile-time guard for flair#3126: remote init's `provisionFabric` binding
 * and its wrapper type as `Promise<ProvisionedFabricPrincipal>`. These checks
 * live in the typecheck only; bun test does not load this file.
 */
import type { InitCli, InitProvisionFabricFn } from "../../src/commands/init.ts";

type IsAny<T> = 0 extends 1 & T ? true : false;
type Not<T extends false> = T;

// Fails to compile when the wrapper's return type widens to `any`.
type WrapperReturnIsNotAny = Not<IsAny<ReturnType<InitProvisionFabricFn>>>;
const wrapperReturnIsNotAny: WrapperReturnIsNotAny = false;

// Fails to compile when the injected binding's return type widens to `any`.
type BindingReturnIsNotAny = Not<IsAny<ReturnType<InitCli["provisionFabric"]>>>;
const bindingReturnIsNotAny: BindingReturnIsNotAny = false;

void wrapperReturnIsNotAny;
void bindingReturnIsNotAny;
