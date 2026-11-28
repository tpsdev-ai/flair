/**
 * Compile-time guard for flair#3126: asserts that the binding and wrapper return
 * types are not `any` and equal `Promise<ProvisionedFabricPrincipal>`.
 * Typecheck-only; bun test does not load this file.
 */
import type { provisionFabric as cliProvisionFabric, ProvisionedFabricPrincipal } from "../../src/cli.ts";
import type { InitCli, InitProvisionFabricFn } from "../../src/commands/init.ts";

type IsAny<T> = 0 extends 1 & T ? true : false;
type Not<T extends false> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

// Fails to compile when the wrapper's return type widens to `any`.
type WrapperReturnIsNotAny = Not<IsAny<ReturnType<InitProvisionFabricFn>>>;
const wrapperReturnIsNotAny: WrapperReturnIsNotAny = false;

// Fails to compile when the injected binding's return type widens to `any`.
type BindingReturnIsNotAny = Not<IsAny<ReturnType<InitCli["provisionFabric"]>>>;
const bindingReturnIsNotAny: BindingReturnIsNotAny = false;

type WrapperReturnIsExact = Assert<Equal<ReturnType<InitProvisionFabricFn>, Promise<ProvisionedFabricPrincipal>>>;
const wrapperReturnIsExact: WrapperReturnIsExact = true;
type BindingReturnIsExact = Assert<Equal<ReturnType<InitCli["provisionFabric"]>, Promise<ProvisionedFabricPrincipal>>>;
const bindingReturnIsExact: BindingReturnIsExact = true;

type WrapperParametersAreExact = Assert<Equal<Parameters<InitProvisionFabricFn>, Parameters<typeof cliProvisionFabric>>>;
const wrapperParametersAreExact: WrapperParametersAreExact = true;
type BindingParametersAreExact = Assert<Equal<Parameters<InitCli["provisionFabric"]>, Parameters<typeof cliProvisionFabric>>>;
const bindingParametersAreExact: BindingParametersAreExact = true;

void wrapperParametersAreExact;
void bindingParametersAreExact;
void wrapperReturnIsExact;
void bindingReturnIsExact;
void wrapperReturnIsNotAny;
void bindingReturnIsNotAny;
